import * as THREE from 'three';

/**
 * Firelight for every lit material.
 *
 * Three's own point lights cost a program per light count and carry a hard hotspot under the bulb. Fire is a glowing body
 * a metre or more across that comes and goes by the dozen, so it gets its own small light list instead: `lights_fragment_begin`
 * is extended with a loop over up to FIRE_MAX lights, each fed through the material's own direct-light equation (so wet
 * asphalt and paintwork catch a highlight, matte sand only the glow). The falloff is the inverse square of a sphere the size
 * of the flames, so the ground right under a fire is bright but never white-hot, windowed to nothing at the light's range.
 *
 * The lights are chosen per view (`game/fires.ts`): the brightest and nearest few of all the fires burning, written into
 * shared typed arrays before the view draws. UniformsUtils.clone hands typed arrays on by reference, so one write updates every
 * material. The count lives in a plain object for the same reason. With nothing burning the loop does not run.
 *
 * The same lights also glow in the air: `FIRE_SCATTER` integrates each one's light scattered toward the eye along a ray
 * (analytically, no march), for the screen-space light pass and the smoke.
 *
 * The nearest fire also casts shadows, so walls, cars and people stand dark against it and it does not light a room
 * through the wall. That takes a depth cube round the fire, which three already knows how to draw and sample for a point
 * light: `fireShadowLight` is one such light that only casts (black, it adds no light of its own), set at the fire the views
 * pick to shade. The fire system puts that fire first in the list and raises `FIRE.info.w`, and the loop darkens light 0 by
 * the light's cube. It is three's only shadow-casting point light, so its map is always `pointShadowMap[ 0 ]`. The light
 * stays in the scene from the start and its map is only redrawn when asked, so programs never change when a fire is lit and
 * nothing is drawn for it while no fire needs it.
 */

/** Most fire lights one view carries. */
export const FIRE_MAX = 8;

export const FIRE = {
  /** xyz: world position, w: radius of the glowing body (m). */
  pos: new Float32Array(FIRE_MAX * 4),
  /** rgb: colour times intensity (as three's point lights: candela-like), w: range (m) past which it adds nothing. */
  col: new Float32Array(FIRE_MAX * 4),
  /** x: lights in use, y: how thick the air is for the glow round them (1/m), z: smoke lit by them, w: 1 when light 0 casts shadows. */
  info: { x: 0, y: 0, z: 1, w: 0 },
};

const uniforms = {
  fireLightPos: { value: FIRE.pos },
  fireLightCol: { value: FIRE.col },
  fireLightInfo: { value: FIRE.info },
};

/** Uniforms for a ShaderMaterial that uses FIRE_PARS (the smoke, the screen-space light pass). */
export function fireUniforms() {
  return { ...uniforms };
}

/** Declarations and helpers. */
export const FIRE_PARS = /* glsl */ `
#ifndef FIRE_PARS_DONE
#define FIRE_PARS_DONE
#define FIRE_MAX ${FIRE_MAX}
uniform vec4 fireLightPos[ FIRE_MAX ];
uniform vec4 fireLightCol[ FIRE_MAX ];
uniform vec4 fireLightInfo;
// Light falling on a point from fire light i, ignoring which way the surface faces.
vec3 fireIrradiance( int i, vec3 wp ) {
  vec4 fp = fireLightPos[ i ];
  vec4 fc = fireLightCol[ i ];
  vec3 lv = fp.xyz - wp;
  float d2 = dot( lv, lv );
  float rr = d2 / ( fc.w * fc.w );
  float win = clamp( 1.0 - rr * rr, 0.0, 1.0 );
  return fc.rgb * ( win * win / ( d2 + fp.w * fp.w ) );
}
// Light scattered toward the eye by thin air along a ray from o (unit direction rd, length len), from every fire light: the
// integral of I / (h^2 + t^2) along the ray is (atan(t1/h) - atan(t0/h)) / h, h being how close the ray passes.
vec3 fireScatter( vec3 o, vec3 rd, float len ) {
  vec3 acc = vec3( 0.0 );
  for ( int i = 0; i < FIRE_MAX; i ++ ) {
    if ( float( i ) >= fireLightInfo.x ) break;
    vec4 fp = fireLightPos[ i ];
    vec4 fc = fireLightCol[ i ];
    vec3 to = fp.xyz - o;
    float tc = dot( to, rd );
    float h2 = max( dot( to, to ) - tc * tc, 0.0 ) + fp.w * fp.w * 0.5;
    float h = sqrt( h2 );
    float a = atan( ( len - tc ) / h ) - atan( - tc / h );
    // Fades out past the light's range, the same as the surfaces it lights.
    float fade = clamp( 1.0 - h / ( fc.w * 0.8 ), 0.0, 1.0 );
    acc += fc.rgb * ( a / h ) * fade * fade;
  }
  // A wall of fire does not glow a hundred times as bright as a campfire through the haze: the eye takes the glow in
  // compressed, and the smoke that thickens the air also stops the light.
  acc *= fireLightInfo.y * 0.0795775;
  return acc / ( 1.0 + dot( acc, vec3( 0.7, 1.2, 0.3 ) ) * 1.4 );
}
#endif
`;

/** The loop that lights a surface, appended to `lights_fragment_begin` (view space: `geometryPosition` is the fragment). */
const FIRE_LIGHTS = /* glsl */ `
#if defined( RE_Direct ) && !defined( FIRE_UNLIT )
if ( fireLightInfo.x > 0.5 ) {
  for ( int fi = 0; fi < FIRE_MAX; fi ++ ) {
    if ( float( fi ) >= fireLightInfo.x ) break;
    vec4 fp = fireLightPos[ fi ];
    vec4 fc = fireLightCol[ fi ];
    vec3 lv = ( viewMatrix * vec4( fp.xyz, 1.0 ) ).xyz - geometryPosition;
    float d2 = dot( lv, lv );
    float rr = d2 / ( fc.w * fc.w );
    if ( rr >= 1.0 ) continue;
    float win = 1.0 - rr * rr;
    directLight.direction = lv * inversesqrt( max( d2, 1e-6 ) );
    directLight.color = fc.rgb * ( win * win / ( d2 + fp.w * fp.w ) );
    directLight.visible = true;
    #if defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0 && ( defined( SHADOWMAP_TYPE_PCF ) || defined( SHADOWMAP_TYPE_BASIC ) )
    // The shadow-casting fire, through the cube its light drew; easing off toward the cube's reach so no edge shows there.
    if ( fi == 0 && fireLightInfo.w > 0.5 && receiveShadow ) {
      float fsh = getPointShadow( pointShadowMap[ 0 ], pointLightShadows[ 0 ].shadowMapSize, pointLightShadows[ 0 ].shadowIntensity, pointLightShadows[ 0 ].shadowBias, pointLightShadows[ 0 ].shadowRadius, vPointShadowCoord[ 0 ], pointLightShadows[ 0 ].shadowCameraNear, pointLightShadows[ 0 ].shadowCameraFar );
      directLight.color *= mix( fsh, 1.0, smoothstep( 0.7, 1.0, sqrt( d2 ) / pointLightShadows[ 0 ].shadowCameraFar ) );
    }
    #endif
    RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  }
}
#endif
`;

let installed = false;

/** Patch three's light chunks and uniforms. Idempotent; call before any material compiles. */
export function installFireLight() {
  if (installed) return;
  installed = true;
  const pars = THREE.ShaderChunk.lights_pars_begin;
  THREE.ShaderChunk.lights_pars_begin = `${pars}\n${FIRE_PARS}`;
  THREE.ShaderChunk.lights_fragment_begin = `${THREE.ShaderChunk.lights_fragment_begin}\n${FIRE_LIGHTS}`;
  const lib = THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, THREE.IUniform> }>;
  for (const k of Object.keys(lib)) Object.assign(lib[k].uniforms, uniforms);
}

let shadowLight: THREE.PointLight | null = null;

/** The light whose shadow the nearest fire casts. The renderer keeps it in its scene for good. */
export function fireShadowLight(): THREE.PointLight {
  if (shadowLight) return shadowLight;
  // Black: three's own light loop skips it (and its shadow lookups); only the fire loop reads its cube.
  const l = new THREE.PointLight(0x000000, 0, 30, 2);
  l.name = 'fireShadow';
  l.castShadow = true;
  const s = l.shadow;
  // Drawn only when the fire system asks. The first frame draws it once (from far below, where nothing is), so a depth map
  // is always bound behind the shadow sampler.
  s.autoUpdate = false;
  s.needsUpdate = true;
  s.mapSize.set(256, 256);
  s.camera.near = 0.1;
  s.bias = 0.0015;
  s.normalBias = 0.05;
  s.radius = blurFor(256);
  l.position.set(0, -10000, 0);
  l.updateMatrixWorld();
  shadowLight = l;
  return l;
}

/** A fire is a glowing body, not a point: its shadows are soft, by the same angle whatever the cube's size. */
function blurFor(n: number): number {
  return 1.5 + n / 64;
}

/** Side of each face of the fire's shadow cube (0 for none at all). */
export function setFireShadowSize(n: number) {
  const s = fireShadowLight().shadow;
  if (n <= 0 || n === s.mapSize.x) return;
  s.mapSize.set(n, n);
  s.radius = blurFor(n);
  // three does not resize a cube target: make it again on the next draw.
  if (s.map) {
    s.map.depthTexture?.dispose();
    s.map.dispose();
    s.map = null as unknown as THREE.WebGLRenderTarget;
  }
  s.needsUpdate = true;
}

/** Cube drawings so far, so a batch is checked once per drawing rather than once per face. */
let aims = 0;

/**
 * Cast the shadows of light 0 from (x, y, z), out to `far` metres, `strength` 0..1 deep. Redraws the cube with the view
 * that follows.
 */
export function aimFireShadow(x: number, y: number, z: number, far: number, strength = 1) {
  const l = fireShadowLight();
  l.position.set(x, y, z);
  l.distance = far;
  l.updateMatrixWorld();
  l.shadow.needsUpdate = true;
  aims++;
  keepFireShadow(strength);
}

const _p = new THREE.Vector3();
const _s = new THREE.Sphere();

/** Whether anything of a batch drawn wherever its members are stands within the fire shadow's reach. */
function batchNearFire(object: THREE.Object3D, geometry: THREE.BufferGeometry): boolean {
  const l = fireShadowLight();
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const bs = geometry.boundingSphere;
  if (!bs) return true;
  const im = object as THREE.InstancedMesh;
  if (!im.isInstancedMesh) {
    _s.copy(bs).applyMatrix4(object.matrixWorld);
    return _s.center.distanceToSquared(l.position) < (l.distance + _s.radius) ** 2;
  }
  const reach = l.distance + bs.radius * object.matrixWorld.getMaxScaleOnAxis();
  const m = im.instanceMatrix.array;
  for (let i = 0; i < im.count; i++) {
    _p.set(m[i * 16 + 12], m[i * 16 + 13], m[i * 16 + 14]).applyMatrix4(object.matrixWorld);
    if (_p.distanceToSquared(l.position) < reach * reach) return true;
  }
  return false;
}

/**
 * Keep the fire's cube to what stands near the fire. three culls each object against each face by its bounds, but a batch's
 * bounds take in all its members: a chunk's trees span a hundred metres, and a batch drawn wherever its members stand (bounds
 * off: the forage plants, a herd, a crowd) has none, so either would be drawn whole into all six faces however far off its
 * members are. In a meadow that was three quarters of the cube's work. A batch goes in only when one of its members stands
 * within the shadow's reach, checked once per drawing of the cube. Installed over the renderer's draw.
 */
export function installFireShadowFilter(gl: THREE.WebGLRenderer) {
  const draw = gl.renderBufferDirect.bind(gl);
  const cam = fireShadowLight().shadow.camera;
  const near = new WeakMap<THREE.Object3D, { aim: number; near: boolean }>();
  gl.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
    if (camera === cam && (object.frustumCulled === false || (object as THREE.InstancedMesh).isInstancedMesh)) {
      let n = near.get(object);
      if (!n) near.set(object, (n = { aim: -1, near: true }));
      if (n.aim !== aims) {
        n.aim = aims;
        n.near = batchNearFire(object, geometry);
      }
      if (!n.near) return;
    }
    draw(camera, scene, geometry, material, object, group);
  };
}

/** Light 0 casts shadows `strength` 0..1 deep from the cube as last drawn (0: none), for the view that follows. */
export function keepFireShadow(strength: number) {
  FIRE.info.w = strength > 0 ? 1 : 0;
  fireShadowLight().shadow.intensity = strength;
}

/** Fires whose heat haze each view shows. */
export const HAZE_MAX = 4;
/**
 * Heat haze over the fires, for the composite: per view (2) and fire (HAZE_MAX), two vec4s. The first is where the hot air
 * stands in that view's own uv (centre x, base y, half width, height), the second how strongly it shimmers and how far off it
 * is (only what lies behind it bends). Written as each view is drawn.
 */
export const FIRE_HAZE = new Float32Array(2 * HAZE_MAX * 8);

/** One light, as the fire system hands it over. */
export interface FireLightIn {
  x: number;
  y: number;
  z: number;
  /** Size of the glowing body, metres. */
  r: number;
  /** Colour times intensity. */
  cr: number;
  cg: number;
  cb: number;
  /** Range, metres. */
  range: number;
}

/** Write the lights a view will draw with. `haze` is the air's thickness for the glow (1/m). */
export function setFireLights(list: readonly FireLightIn[], n: number, haze: number) {
  const m = Math.min(n, FIRE_MAX);
  for (let i = 0; i < m; i++) {
    const l = list[i];
    FIRE.pos[i * 4] = l.x;
    FIRE.pos[i * 4 + 1] = l.y;
    FIRE.pos[i * 4 + 2] = l.z;
    FIRE.pos[i * 4 + 3] = l.r;
    FIRE.col[i * 4] = l.cr;
    FIRE.col[i * 4 + 1] = l.cg;
    FIRE.col[i * 4 + 2] = l.cb;
    FIRE.col[i * 4 + 3] = Math.max(1, l.range);
  }
  FIRE.info.x = m;
  FIRE.info.y = haze;
}

/** No fire anywhere (a scene being torn down, a delve with none). */
export function clearFireLights() {
  FIRE.info.x = 0;
  FIRE.info.w = 0;
}
