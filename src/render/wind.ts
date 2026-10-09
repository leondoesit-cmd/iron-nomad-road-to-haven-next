import * as THREE from 'three';
import { GLOBALS } from './materials';

/**
 * The wind in the plants. Every swaying thing (trees, their impostors, grass and the other ground cover, the wild food
 * plants) reads the same air: the weather's wind (`setPlantWind`), with gusts rolling downwind across the country so
 * neighbours lean together and a gust can be watched crossing a meadow.
 *
 * A plant answers in parts, each by its own size: a leaf stirs in a breath of air, a twig in a breeze, a limb in a wind,
 * a trunk only in a gale (the order of the Beaufort scale), and the lighter the part the sooner it answers. Each part also
 * swings at its own pace, slower the bigger it is.
 */

/** Gusts repeat every GUST_WRAP metres of travelled air; their wavenumbers fit it exactly, so the wrap never shows. */
const GUST_WRAP = 2000;
const k = (n: number) => ((2 * Math.PI * n) / GUST_WRAP).toFixed(7);

export const WIND = {
  /** x and z: the wind over the ground (m/s); w: a master scale on every plant's answer (0 stills them all). */
  uWind: { value: new THREE.Vector4(1.28, 0, -0.96, 1) },
  /** How far the air has travelled (m, wrapped), so the gusts roll on smoothly whatever the wind does. */
  uWindRun: { value: 0 },
};

/** Ease the plants' wind toward the weather's (m/s) and carry the gusts downwind. The weather calls it every tick. */
export function setPlantWind(x: number, z: number, dt: number) {
  if (dt <= 0) return;
  const w = WIND.uWind.value;
  const ease = 1 - Math.exp(-dt / 1.5);
  w.x += (x - w.x) * ease;
  w.z += (z - w.z) * ease;
  WIND.uWindRun.value = (WIND.uWindRun.value + Math.hypot(w.x, w.z) * dt) % GUST_WRAP;
}

/** Give a shader the wind's uniforms; WIND_GLSL declares them. */
export function windUniforms(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.uniforms.uTime = GLOBALS.uTime;
  shader.uniforms.uWind = WIND.uWind;
  shader.uniforms.uWindRun = WIND.uWindRun;
}

/** The air and how plants answer it, for a vertex shader (after `#include <common>`). */
export const WIND_GLSL = /* glsl */ `
uniform float uTime;
uniform vec4 uWind;
uniform float uWindRun;

// The air where a plant stands: its direction (x, z, unit), its steady speed and its gusting speed (m/s). Gusts are cells
// of faster air carried downwind at the wind's own speed: a broad swell with quicker puffs riding in it, both wavering
// across the wind, and the air veering a little as one comes through.
vec4 windHere( vec2 p ) {
  float v = length( uWind.xz );
  vec2 d = v > 1e-3 ? uWind.xz / v : vec2( 0.8, -0.6 );
  float a = dot( p, d ) - uWindRun;
  float c = dot( p, vec2( -d.y, d.x ) );
  float swell = sin( a * ${k(14)} + sin( c * 0.019 + uWindRun * ${k(1)} ) * 1.6 );
  float puff = sin( a * ${k(41)} + c * 0.047 + 1.3 ) * 0.6 + sin( a * ${k(99)} - c * 0.11 + 4.0 ) * 0.4;
  float veer = 0.22 * sin( a * ${k(23)} + c * 0.031 + 2.0 );
  d = vec2( d.x * cos( veer ) - d.y * sin( veer ), d.x * sin( veer ) + d.y * cos( veer ) );
  // Even on a still day the air near the ground stirs a little.
  float s = max( v * ( 1.0 + 0.32 * swell ) + 0.35 + 0.15 * swell, 0.0 );
  return vec4( d, s, max( s + ( v * 0.22 + 0.2 ) * puff, 0.0 ) );
}

// How far each part of a plant answers air moving at u m/s.
float windLeaf( float u ) { return 1.0 - exp( -u * 0.35 ) + u * 0.015; }
float windTwig( float u ) { return min( pow( u * 0.125, 1.5 ), 2.4 ); }
float windLimb( float u ) { return min( pow( u * 0.083, 1.8 ), 2.4 ); }
float windTrunk( float u ) { return min( u * u * 0.0039, 2.0 ); }
// A herb leans over at once and lies down in a gale.
float windHerb( float u ) { return 1.0 - exp( -u * 0.16 ); }

// v turned by the rotation vector w (its axis, its length the angle).
vec3 windTurn( vec3 v, vec3 w ) {
  float a = length( w );
  if ( a < 1e-5 ) return v;
  vec3 k = w / a;
  float c = cos( a );
  return v * c + cross( k, v ) * sin( a ) + k * dot( k, v ) * ( 1.0 - c );
}

// A plant's own timing, from where it stands.
float windSeed( vec2 p ) { return fract( sin( dot( floor( p * 4.0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * 6.2832; }
`;

/** How a small plant takes the wind (`PLANT_SWAY_GLSL`). */
export interface PlantWind {
  /** How far (rad) its stems lie over in a gale. */
  lean: number;
  /** The stems' natural pace (rad/s), e.g. the spring a passing car bends them with (`PLANT_MECHANICS`). */
  rate: number;
  /** How far its leaves flutter at the top (its own units), and how quickly (Hz). */
  leaf: number;
  leafHz: number;
}

/** Give a shader the wind's uniforms and a plant's own; PLANT_SWAY_GLSL declares them. */
export function plantUniforms(shader: THREE.WebGLProgramParametersWithUniforms, w: PlantWind) {
  windUniforms(shader);
  shader.uniforms.uPlant = { value: new THREE.Vector4(w.lean, w.rate, w.leaf, w.leafHz) };
}

/** A small plant in the wind, for a vertex shader (after `#include <common>`; it brings WIND_GLSL along). */
export const PLANT_SWAY_GLSL = /* glsl */ `${WIND_GLSL}
uniform vec4 uPlant;

// A small plant's vertex p (in its own frame, the root at the origin) in the wind; f is the share of the plant's height it
// is at (0 at the root, 1 at the top). The stem leans downwind at once (a small plant further than a big one of its kind),
// rocks about that lean at its own pace and a little across the wind, bending more toward its top and keeping its length.
// Its leaves flutter on top of that: every part of the plant at its own time, set by the way it grows out from the root, so
// one bush is never a single block of motion.
vec3 plantSway( vec3 p, float f ) {
#ifdef USE_INSTANCING
  mat3 pM = mat3( instanceMatrix );
  vec3 pO = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
#else
  mat3 pM = mat3( 1.0 );
  vec3 pO = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
#endif
  float sc = max( length( pM[ 1 ] ), 0.2 );
  mat3 pR = mat3( normalize( pM[ 0 ] ), pM[ 1 ] / sc, normalize( pM[ 2 ] ) );
  vec4 a = windHere( pO.xz );
  vec3 W = transpose( pR ) * vec3( a.x, 0.0, a.y );
  vec3 U = transpose( pR ) * vec3( 0.0, 1.0, 0.0 );
  vec3 C = cross( U, W );
  float ph = windSeed( pO.xz * 2.0 );
  float lean = uPlant.x * windHerb( a.z ) * pow( sc, -0.4 ) * uWind.w;
  float rate = uPlant.y * inversesqrt( sc );
  float rock = sin( uTime * rate + ph ) * 0.7 + sin( uTime * rate * 2.3 + ph * 1.9 ) * 0.3;
  vec3 bend = ( W * ( 1.0 + 0.4 * rock ) + C * 0.3 * sin( uTime * rate * 1.17 + ph * 2.3 ) ) * lean * max( p.y, 0.0 ) * f;
  float len = length( p );
  vec3 q = len > 1e-4 ? normalize( p + bend ) * len : p;
  float grow = atan( p.z, p.x + 1e-5 ) * 2.0 + length( p.xz ) * 2.6 + p.y * 1.7;
  float t = uTime * uPlant.w * 6.2832 + grow + ph;
  vec3 side = normalize( vec3( -p.z, 0.0, p.x ) + vec3( 1e-4 ) );
  vec3 flutter = W * ( 0.5 + 0.5 * sin( t ) ) + side * sin( t * 1.37 + 0.8 ) + U * 0.35 * sin( t * 0.83 + 2.1 );
  return q + flutter * uPlant.z * windLeaf( a.w ) * min( f, 1.5 ) * uWind.w;
}
`;
