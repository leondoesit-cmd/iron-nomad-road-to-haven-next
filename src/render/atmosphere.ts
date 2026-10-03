import * as THREE from 'three';

/**
 * Aerial perspective for every material: three's fog chunks are replaced with distance fog plus a
 * ground-hugging haze layer and in-scattering toward the sun, so distant terrain fades into a warm,
 * directional haze instead of a flat colour.
 *
 * The extra uniforms are plain objects (not Vector3s), so UniformsUtils.clone hands every material the
 * same reference and one write per frame updates all of them.
 */
export const ATMO = {
  sunDir: { x: 0.4, y: 0.8, z: 0.3 },
  /** rgb: in-scattered sun colour, a: strength. */
  sunCol: { x: 1, y: 0.8, z: 0.55, w: 0.6 },
  /** x: haze density (1/m), y: haze falloff with height (1/m), z: haze base height (m), w: max fog. */
  params: { x: 0.004, y: 0.06, z: 0, w: 1 },
};

const uniforms = {
  atmoSunDir: { value: ATMO.sunDir },
  atmoSunCol: { value: ATMO.sunCol },
  atmoParams: { value: ATMO.params },
};

/** Uniforms to spread into a ShaderMaterial that sets `fog: true`. */
export function atmoUniforms() {
  return { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...uniforms };
}

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogView;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogView = mvPosition.xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform vec3 atmoSunDir;
  uniform vec4 atmoSunCol;
  uniform vec4 atmoParams;
  varying float vFogDepth;
  varying vec3 vFogView;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  vec3 atmoApply( vec3 col ) {
    vec3 ray = ( vec4( vFogView, 0.0 ) * viewMatrix ).xyz;
    float dist = length( ray );
    vec3 dir = ray / max( dist, 1e-3 );
    #ifdef FOG_EXP2
      float f = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float f = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    // Height haze: density falls off exponentially above the base height, integrated along the ray.
    float k = max( atmoParams.y, 1e-4 );
    float h0 = cameraPosition.y - atmoParams.z;
    float dy = ray.y;
    float shape = abs( dy * k ) > 1e-4 ? ( 1.0 - exp( - k * dy ) ) / ( k * dy ) : 1.0;
    float haze = atmoParams.x * exp( - k * h0 ) * shape * dist;
    f = max( f, 1.0 - exp( - haze ) );
    f = min( f, atmoParams.w );
    float sun = max( dot( dir, atmoSunDir ), 0.0 );
    vec3 fc = fogColor + atmoSunCol.rgb * atmoSunCol.a * ( pow( sun, 28.0 ) * 0.35 + pow( sun, 120.0 ) * 0.45 );
    return mix( col, fc, f );
  }
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  gl_FragColor.rgb = atmoApply( gl_FragColor.rgb );
#endif
`;

let installed = false;

/** Install the atmosphere chunks and uniforms. Idempotent; call before any material compiles. */
export function installAtmosphere() {
  if (installed) return;
  installed = true;
  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;
  const lib = THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, THREE.IUniform> }>;
  for (const k of Object.keys(lib)) Object.assign(lib[k].uniforms, uniforms);
}

/** Copy the frame's sun and haze settings into the shared uniforms. */
export function setAtmosphere(sunDir: THREE.Vector3, sunColor: THREE.Color, scatter: number, haze: number, hazeFalloff: number, hazeBase: number) {
  ATMO.sunDir.x = sunDir.x;
  ATMO.sunDir.y = sunDir.y;
  ATMO.sunDir.z = sunDir.z;
  ATMO.sunCol.x = sunColor.r;
  ATMO.sunCol.y = sunColor.g;
  ATMO.sunCol.z = sunColor.b;
  ATMO.sunCol.w = scatter;
  ATMO.params.x = haze;
  ATMO.params.y = hazeFalloff;
  ATMO.params.z = hazeBase;
}
