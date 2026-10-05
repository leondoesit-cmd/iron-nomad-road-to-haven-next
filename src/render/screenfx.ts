import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Screen-space lighting for the HDR scene target. Each player view runs these right after it has been drawn, while that view's
 * camera, depth and the sun's shadow map are still the ones in use:
 *
 *  1. Ground-truth ambient occlusion (GTAO) from the depth buffer, in the same half-resolution pass as the volumetric light.
 *     It grounds tyres in ruts, darkens the crevice under a chassis and fills building interiors with contact shadow.
 *  2. Volumetric light: a ray is marched from the camera to the surface through a layer of dust, and every step asks the
 *     sun's shadow map whether that bit of air is lit. Shadow from a skyscraper or a bridge girder becomes a visible shaft.
 *     A short radial march toward the sun adds the shafts of skyline too far away for the shadow map to know about.
 *  3. A depth-aware blur of the two results, so the sampling noise never reaches the screen.
 *  4. Screen-space reflections, for pixels the materials marked as glossy (gloss.ts) and for water.
 *
 * Results are composited by `PostFX`: AO multiplies the scene (less where the light is bright, so sunlit ground is not
 * dirtied), reflections are mixed in by their Fresnel weight, and the scattered light is added.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

/** Depth, view-space reconstruction and the per-view uniforms every pass shares. `vUv` is local to the view's rect. */
const COMMON = /* glsl */ `
uniform sampler2D tDepth;
uniform vec4 uRect;
uniform vec2 uProjXY;
uniform vec2 uNearFar;
uniform vec2 uPix;
varying vec2 vUv;
float linZ( float d ) {
  return ( uNearFar.x * uNearFar.y ) / ( ( uNearFar.y - uNearFar.x ) * d - uNearFar.y );
}
vec2 gUv( vec2 l ) {
  return uRect.xy + clamp( l, vec2( 0.0005 ), vec2( 0.9995 ) ) * uRect.zw;
}
// The depth buffer is not filtered. A read that falls on the line between two of its pixels (and every pixel of the
// half-resolution pass does) lands on one or the other by rounding that drifts across the screen: the surface normal and
// the occlusion flip with it, and the ground shows dark bands. Every read goes to the middle of one pixel instead, picked
// the same way every time.
vec2 snapL( vec2 l ) {
  return ( floor( l / uPix + 0.25 ) + 0.5 ) * uPix;
}
float dAt( vec2 l ) {
  return texture2D( tDepth, gUv( snapL( l ) ) ).r;
}
float zAt( vec2 l ) {
  return linZ( dAt( l ) );
}
vec3 viewPos( vec2 l, float z ) {
  return vec3( ( l * 2.0 - 1.0 ) * uProjXY * ( - z ), z );
}
float ign( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}
float hash21( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float vnoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( hash21( i ), hash21( i + vec2( 1.0, 0.0 ) ), f.x ), mix( hash21( i + vec2( 0.0, 1.0 ) ), hash21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
// Surface normal from depth, taking symmetric difference on smooth surfaces to prevent row chattering,
// switching to one-sided difference near silhouettes to preserve crisp edges.
vec3 normalAt( vec2 l, float z, vec3 P ) {
  vec2 e = uPix;
  float zl = zAt( l - vec2( e.x, 0.0 ) );
  float zr = zAt( l + vec2( e.x, 0.0 ) );
  float zd = zAt( l - vec2( 0.0, e.y ) );
  float zu = zAt( l + vec2( 0.0, e.y ) );
  bool discX = abs( zr - z ) > abs( zl - z ) * 2.5 || abs( zl - z ) > abs( zr - z ) * 2.5;
  bool discY = abs( zu - z ) > abs( zd - z ) * 2.5 || abs( zd - z ) > abs( zu - z ) * 2.5;
  vec3 dx = discX ? ( abs( zr - z ) < abs( zl - z ) ? viewPos( l + vec2( e.x, 0.0 ), zr ) - P : P - viewPos( l - vec2( e.x, 0.0 ), zl ) )
                  : ( viewPos( l + vec2( e.x, 0.0 ), zr ) - viewPos( l - vec2( e.x, 0.0 ), zl ) ) * 0.5;
  vec3 dy = discY ? ( abs( zu - z ) < abs( zd - z ) ? viewPos( l + vec2( 0.0, e.y ), zu ) - P : P - viewPos( l - vec2( 0.0, e.y ), zd ) )
                  : ( viewPos( l + vec2( 0.0, e.y ), zu ) - viewPos( l - vec2( 0.0, e.y ), zd ) ) * 0.5;
  return normalize( cross( dx, dy ) );
}
`;

const LIGHT_FRAG = /* glsl */ `
${COMMON}
uniform mat3 uCamRot;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunLight;
uniform vec2 uSunUv;
uniform vec4 uAo;
uniform vec4 uVol;
uniform vec4 uVol2;
uniform vec4 uRad;
uniform mat4 uShadowMat;
uniform sampler2DShadow tShadow;
uniform float uShadowBias;
uniform float uTime;
uniform float uAspect;
const float PI = 3.14159265;
const float HALF_PI = 1.57079633;

float gtao( vec2 l, float z, vec3 P ) {
  // uAo: x radius (m), y pixels per metre at 1 m depth, z on
  float radiusPx = uAo.x * uAo.y / ( - z );
  if ( radiusPx < 2.5 ) return 1.0;
  radiusPx = min( radiusPx, 140.0 );
  vec3 N = normalAt( l, z, P );
  vec3 V = normalize( - P );
  float nS = ign( gl_FragCoord.xy );
  float nT = ign( gl_FragCoord.xy + vec2( 5.588238, 5.588238 ) );
  float vis = 0.0;
  for ( int s = 0; s < AO_SLICES; s++ ) {
    float phi = ( float( s ) + nS ) / float( AO_SLICES ) * PI;
    vec2 omega = vec2( cos( phi ), sin( phi ) );
    vec3 dirV = vec3( omega, 0.0 );
    vec3 ortho = dirV - dot( dirV, V ) * V;
    vec3 axis = normalize( cross( ortho, V ) );
    vec3 projN = N - axis * dot( N, axis );
    float projLen = length( projN );
    float signN = dot( ortho, projN ) >= 0.0 ? 1.0 : -1.0;
    float cosN = clamp( dot( projN, V ) / max( projLen, 1e-4 ), 0.0, 1.0 );
    float n = signN * acos( cosN );
    float lc0 = cos( n + HALF_PI );
    float lc1 = cos( n - HALF_PI );
    float hc0 = lc0;
    float hc1 = lc1;
    for ( int i = 0; i < AO_STEPS; i++ ) {
      float t = ( float( i ) + nT ) / float( AO_STEPS );
      float off = max( t * t * radiusPx, 1.5 + float( i ) );
      vec2 so = omega * off * uPix;
      vec2 uv0 = l + so;
      vec2 uv1 = l - so;
      vec3 D0 = viewPos( uv0, zAt( uv0 ) ) - P;
      vec3 D1 = viewPos( uv1, zAt( uv1 ) ) - P;
      float d0 = max( length( D0 ), 1e-4 );
      float d1 = max( length( D1 ), 1e-4 );
      float w0 = clamp( ( uAo.x - d0 ) / ( uAo.x * 0.6 ), 0.0, 1.0 );
      float w1 = clamp( ( uAo.x - d1 ) / ( uAo.x * 0.6 ), 0.0, 1.0 );
      hc0 = max( hc0, mix( lc0, dot( D0 / d0, V ), w0 ) );
      hc1 = max( hc1, mix( lc1, dot( D1 / d1, V ), w1 ) );
    }
    projLen = mix( projLen, 1.0, 0.05 );
    float h0 = - acos( clamp( hc1, -1.0, 1.0 ) );
    float h1 = acos( clamp( hc0, -1.0, 1.0 ) );
    h0 = n + clamp( h0 - n, - HALF_PI, HALF_PI );
    h1 = n + clamp( h1 - n, - HALF_PI, HALF_PI );
    float a0 = ( cosN + 2.0 * h0 * sin( n ) - cos( 2.0 * h0 - n ) ) * 0.25;
    float a1 = ( cosN + 2.0 * h1 * sin( n ) - cos( 2.0 * h1 - n ) ) * 0.25;
    vis += projLen * ( a0 + a1 );
  }
  vis = clamp( vis / float( AO_SLICES ), 0.0, 1.0 );
  vis = max( pow( vis, 1.7 ), 0.03 );
  return mix( vis, 1.0, smoothstep( 35.0, 100.0, - z ) );
}

// Sunlight scattered toward the camera by dust, marched through the sun's shadow map.
vec3 shafts( vec2 l, float d, float z, float jit ) {
  // uVol: x density at the ground (1/m), y height falloff (1/m), z base height (m), w furthest march (m)
  // uVol2: x anisotropy, y wind time, z unused, w unused
  vec2 ndc = l * 2.0 - 1.0;
  vec3 dirV = vec3( ndc * uProjXY, -1.0 );
  float zEnd = d >= 1.0 ? uVol.w : min( - z, uVol.w );
  float lenV = length( dirV );
  vec3 rd = normalize( uCamRot * dirV );
  float g = uVol2.x;
  float cs = dot( rd, uSunDir );
  // Henyey-Greenstein, normalised so a uniform medium averages about 1; a little isotropic floor keeps back-lit dust alive.
  float phase = mix( 1.0, ( 1.0 - g * g ) / pow( 1.0 + g * g - 2.0 * g * cs, 1.5 ), 0.75 ) * 0.5;
  phase = min( phase, 3.0 );
  float ds = zEnd / float( VOL_STEPS );
  float T = 1.0;
  float acc = 0.0;
  for ( int i = 0; i < VOL_STEPS; i++ ) {
    float s = ( float( i ) + jit ) * ds;
    vec3 wp = uCamPos + uCamRot * ( dirV * s );
    float dens = uVol.x * exp( - max( wp.y - uVol.z, 0.0 ) * uVol.y );
    // Dust billows and drifts on the wind.
    vec2 wq = wp.xz * 0.06 + vec2( uVol2.y, uVol2.y * 0.6 );
    dens *= 0.35 + 1.3 * vnoise( wq ) * ( 0.6 + 0.8 * vnoise( wq * 2.7 + wp.y * 0.05 ) );
    vec4 sc = uShadowMat * vec4( wp, 1.0 );
    vec3 suv = sc.xyz / sc.w;
    vec2 edge = min( suv.xy, 1.0 - suv.xy );
    float inBox = smoothstep( 0.0, 0.14, min( edge.x, edge.y ) ) * step( 0.0, suv.z ) * step( suv.z, 1.0 );
    float vis = 1.0;
    if ( inBox > 0.0 ) vis = texture( tShadow, vec3( suv.xy, suv.z - uShadowBias ) );
    float seg = dens * ds * lenV;
    acc += T * seg * vis * inBox;
    T *= exp( - seg * 0.6 );
  }
  return uSunLight * ( acc * phase );
}

// Shafts of the distant skyline: march from this pixel toward the sun and count how much of the sun's glow is left unblocked.
vec3 radial( vec2 l, float jit ) {
  // uRad: x strength, y glow tightness, z on-screen-ness of the sun, w unused
  vec2 delta = uSunUv - l;
  float dist = length( delta * vec2( uAspect, 1.0 ) );
  // Shafts fan out of the sun's glow only; further than about a screen's height away they must vanish, or the whole frame washes out.
  float radWeight = smoothstep( 1.0, 0.0, dist );
  radWeight *= radWeight;
  if ( radWeight <= 0.001 ) return vec3( 0.0 );

  vec2 stepv = delta / float( RAD_STEPS );
  vec2 suv = l + stepv * jit;
  float illum = 1.0;
  float acc = 0.0;
  for ( int i = 0; i < RAD_STEPS; i++ ) {
    suv += stepv;
    float dd = dAt( suv );
    vec2 q = ( suv - uSunUv ) * vec2( uAspect, 1.0 );
    float glow = exp( - dot( q, q ) * uRad.y );
    acc += step( 0.99999, dd ) * glow * illum;
    illum *= 0.94;
  }
  return uSunLight * ( ( acc / float( RAD_STEPS ) ) * uRad.x * radWeight * 0.4 );
}

void main() {
  vec2 l = snapL( vUv );
  float d = dAt( l );
  float z = linZ( d );
  float jit = ign( gl_FragCoord.xy + vec2( 17.0, 3.0 ) );
  float ao = 1.0;
  if ( uAo.z > 0.5 && d < 1.0 ) ao = gtao( l, z, viewPos( l, z ) );
  vec3 light = vec3( 0.0 );
  if ( uVol.x > 0.0 ) light += shafts( l, d, z, jit );
  if ( uRad.x > 0.0 && uRad.z > 0.5 ) light += radial( l, jit );
  gl_FragColor = vec4( min( light, vec3( 16.0 ) ), ao );
}`;

const BLUR_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tSrc;
uniform vec2 uDir;
void main() {
  vec2 l = vUv;
  float zc = zAt( l );
  float dz = uDir.x > 0.0 ? dFdx( zc ) : dFdy( zc );
  float tol = max( 0.04 * abs( zc ) + 0.12, abs( dz ) * 2.0 );
  vec4 sum = texture2D( tSrc, gUv( l ) ) * 0.2;
  float wsum = 0.2;
  for ( int i = 1; i <= 4; i++ ) {
    float w0 = exp( - float( i * i ) * 0.09 );
    for ( int s = 0; s < 2; s++ ) {
      float fi = s == 0 ? float( i ) : - float( i );
      vec2 o = uDir * fi;
      vec2 tl = clamp( l + o, vec2( 0.0005 ), vec2( 0.9995 ) );
      float zi = zAt( tl );
      float zExp = zc + dz * fi;
      float diff = min( abs( zi - zc ), abs( zi - zExp ) );
      float w = w0 * exp( - diff / tol );
      sum += texture2D( tSrc, gUv( tl ) ) * w;
      wsum += w;
    }
  }
  gl_FragColor = sum / max( wsum, 1e-4 );
}`;

const SSR_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tColor;
uniform mat4 uProj;
uniform mat3 uCamRot;
uniform vec2 uRes;
uniform vec4 uSsr;
void main() {
  gl_FragColor = vec4( 0.0 );
  vec2 l = vUv;
  vec4 hd = texture2D( tColor, gUv( l ) );
  float R = clamp( 1.0 - hd.a, 0.0, 1.0 );
  if ( R < 0.004 ) return;
  float d = dAt( l );
  if ( d >= 1.0 ) return;
  // Opaque surfaces never write above 0.95; the water sheet writes alpha 0 (R of 1).
  bool water = R > 0.97;
  float sm = water ? 1.0 : clamp( R / 0.03, 0.0, 1.0 );
  float z = linZ( d );
  vec3 P = viewPos( l, z );
  vec3 up = normalize( transpose( uCamRot ) * vec3( 0.0, 1.0, 0.0 ) );
  vec3 N = water ? up : normalAt( l, z, P );
  // Standing water and wet shores are flat, whatever the terrain mesh under them does.
  N = normalize( mix( N, up, sm * smoothstep( 0.85, 0.97, dot( N, up ) ) ) );
  vec3 Vv = normalize( P );
  float cosT = clamp( dot( - Vv, N ), 0.0, 1.0 );
  float F0 = water ? 0.02 : R;
  float F = min( F0 + ( 1.0 - F0 ) * pow( 1.0 - cosT, 5.0 ) * sm, 0.95 );
  if ( F < 0.012 ) return;
  vec3 Rr = reflect( Vv, N );
  if ( Rr.z > 0.35 ) return;
  float away = 1.0 - clamp( Rr.z / 0.35, 0.0, 1.0 );
  // March in screen space: clip the segment to the view, then step with perspective-correct depth.
  float maxLen = uSsr.x;
  vec3 P1 = P + Rr * maxLen;
  if ( P1.z > - uNearFar.x - 0.05 ) P1 = P + Rr * ( ( - uNearFar.x - 0.05 - P.z ) / Rr.z );
  vec4 c0 = uProj * vec4( P, 1.0 );
  vec4 c1 = uProj * vec4( P1, 1.0 );
  vec2 uv0 = c0.xy / c0.w * 0.5 + 0.5;
  vec2 uv1 = c1.xy / c1.w * 0.5 + 0.5;
  float k0 = 1.0 / c0.w;
  float k1 = 1.0 / c1.w;
  float z0 = P.z * k0;
  float z1 = P1.z * k1;
  vec2 dv = uv1 - uv0;
  float tMax = 1.0;
  if ( dv.x > 1e-5 ) tMax = min( tMax, ( 0.999 - uv0.x ) / dv.x );
  if ( dv.x < -1e-5 ) tMax = min( tMax, ( 0.001 - uv0.x ) / dv.x );
  if ( dv.y > 1e-5 ) tMax = min( tMax, ( 0.999 - uv0.y ) / dv.y );
  if ( dv.y < -1e-5 ) tMax = min( tMax, ( 0.001 - uv0.y ) / dv.y );
  float jit = ign( gl_FragCoord.xy );
  float lenPx = length( dv * tMax * uRes );
  if ( lenPx < 6.0 ) return;
  float thick = 0.25 + 0.04 * ( - z );
  float tPrev = 0.0;
  float tHit = -1.0;
  for ( int i = 0; i < SSR_STEPS; i++ ) {
    float f = ( float( i ) + 0.2 + 0.8 * jit ) / float( SSR_STEPS );
    // Start a couple of pixels out so the surface cannot hit itself, then spread the samples toward the far end.
    float t = ( 2.0 + f * f * ( lenPx - 2.0 ) ) / lenPx * tMax;
    vec2 uv = uv0 + dv * t;
    float k = mix( k0, k1, t );
    float rz = mix( z0, z1, t ) / k;
    float sz = zAt( uv );
    float diff = sz - rz;
    if ( diff > 0.01 + 0.004 * ( - z ) && diff < thick && dAt( uv ) < 1.0 ) {
      tHit = t;
      break;
    }
    tPrev = t;
  }
  if ( tHit < 0.0 ) return;
  float lo = tPrev;
  float hi = tHit;
  for ( int i = 0; i < 5; i++ ) {
    float mid = ( lo + hi ) * 0.5;
    vec2 uv = uv0 + dv * mid;
    float rz = mix( z0, z1, mid ) / mix( k0, k1, mid );
    if ( zAt( uv ) - rz > 0.0 ) hi = mid; else lo = mid;
  }
  vec2 huv = uv0 + dv * hi;
  vec3 col = texture2D( tColor, gUv( huv ) ).rgb;
  vec2 e = min( huv, 1.0 - huv );
  float edge = smoothstep( 0.0, 0.12, min( e.x, e.y ) );
  float reach = 1.0 - smoothstep( 0.55, 1.0, hi / max( tMax, 1e-4 ) ) * 0.6;
  float conf = edge * away * reach;
  gl_FragColor = vec4( min( col, vec3( 12.0 ) ), F * conf * uSsr.y );
}`;

export interface FxParams {
  /** 0 off, 1 full: how much the occlusion darkens. */
  aoStrength: number;
  /** Occlusion search radius in metres. */
  aoRadius: number;
  /** Dust density at the ground (1/m); 0 turns the volumetric light off. */
  dust: number;
  /** Dust height falloff (1/m). */
  dustFall: number;
  /** Strength of the screen-space shafts toward the sun. */
  shafts: number;
  /** Colour and brightness of the sun as the scattering sees it (zero at night and underground). */
  sunLight: THREE.Color;
  /** Reflection strength multiplier. */
  reflect: number;
}

export interface FxView {
  camera: THREE.PerspectiveCamera;
  /** The view's rectangle in HDR target pixels (origin bottom-left). */
  rect: { x: number; y: number; w: number; h: number };
  sunDir: THREE.Vector3;
  shadow: THREE.DirectionalLightShadow;
  time: number;
}

/** Sample counts per quality tier: ao slices and steps, volumetric steps, radial steps, reflection steps. */
const TIERS = [
  { ao: [2, 4], vol: 14, rad: 10, ssr: 20 },
  { ao: [3, 6], vol: 24, rad: 18, ssr: 32 },
];

const _rot = new THREE.Matrix3();
const _v = new THREE.Vector3();

export class ScreenFX {
  private quad = new FullScreenQuad();
  private light: THREE.ShaderMaterial;
  private blur: THREE.ShaderMaterial;
  private ssrMat: THREE.ShaderMaterial;
  /** Half-resolution AO (alpha) and scattered light (rgb): raw, blurred across, blurred down. */
  private half: THREE.WebGLRenderTarget[] = [];
  /** Full-resolution reflections: colour and mix weight. */
  ssr: THREE.WebGLRenderTarget;
  private tier = 1;
  private frames = 0;
  params: FxParams = {
    aoStrength: 1,
    aoRadius: 1.6,
    dust: 0.0008,
    dustFall: 0.05,
    shafts: 0,
    sunLight: new THREE.Color(0, 0, 0),
    reflect: 1,
  };
  width = 4;
  height = 4;
  /** Clip planes of the last view run, for the composite's depth-aware upsample. */
  near = 0.2;
  far = 2600;

  constructor(private depth: THREE.DepthTexture) {
    const t = TIERS[this.tier];
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false };
    for (let i = 0; i < 3; i++) this.half.push(new THREE.WebGLRenderTarget(4, 4, opts));
    this.ssr = new THREE.WebGLRenderTarget(4, 4, { ...opts, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
    const shared = () => ({
      tDepth: { value: this.depth },
      uRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uProjXY: { value: new THREE.Vector2(1, 1) },
      uNearFar: { value: new THREE.Vector2(0.2, 2600) },
      uPix: { value: new THREE.Vector2(1, 1) },
    });
    const mat = (frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, number | string> = {}) =>
      new THREE.ShaderMaterial({ uniforms: { ...shared(), ...uniforms }, defines, vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false });
    this.light = mat(
      LIGHT_FRAG,
      {
        uCamRot: { value: new THREE.Matrix3() },
        uCamPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunLight: { value: new THREE.Vector3() },
        uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
        uAo: { value: new THREE.Vector4(1.6, 1, 1, 0) },
        uVol: { value: new THREE.Vector4(0, 0.05, 0, 110) },
        uVol2: { value: new THREE.Vector4(0.55, 0, 0, 0) },
        uRad: { value: new THREE.Vector4(0, 6, 0, 0) },
        uShadowMat: { value: new THREE.Matrix4() },
        tShadow: { value: null },
        uShadowBias: { value: 0.002 },
        uTime: { value: 0 },
        uAspect: { value: 1 },
      },
      { AO_SLICES: t.ao[0], AO_STEPS: t.ao[1], VOL_STEPS: t.vol, RAD_STEPS: t.rad },
    );
    this.blur = mat(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.ssrMat = mat(
      SSR_FRAG,
      {
        tColor: { value: null },
        uProj: { value: new THREE.Matrix4() },
        uCamRot: { value: new THREE.Matrix3() },
        uRes: { value: new THREE.Vector2(1, 1) },
        uSsr: { value: new THREE.Vector4(70, 1, 0, 0) },
      },
      { SSR_STEPS: t.ssr },
    );
  }

  /** 0 for the medium preset, 1 for high. Rebuilds the shaders only when the tier changes. */
  setTier(n: number) {
    n = Math.max(0, Math.min(TIERS.length - 1, Math.round(n)));
    if (n === this.tier) return;
    this.tier = n;
    const t = TIERS[n];
    Object.assign(this.light.defines, { AO_SLICES: t.ao[0], AO_STEPS: t.ao[1], VOL_STEPS: t.vol, RAD_STEPS: t.rad });
    this.light.needsUpdate = true;
    this.ssrMat.defines.SSR_STEPS = t.ssr;
    this.ssrMat.needsUpdate = true;
  }

  setSize(w: number, h: number) {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    const hw = Math.max(2, Math.ceil(w / 2));
    const hh = Math.max(2, Math.ceil(h / 2));
    for (const r of this.half) r.setSize(hw, hh);
    this.ssr.setSize(w, h);
  }

  /** The AO and light texture, at half resolution. */
  get lightTexture() {
    return this.half[2].texture;
  }

  get lightWidth() {
    return this.half[2].width;
  }

  get lightHeight() {
    return this.half[2].height;
  }

  private pass(gl: THREE.WebGLRenderer, mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget, x: number, y: number, w: number, h: number) {
    target.viewport.set(x, y, w, h);
    target.scissor.set(x, y, w, h);
    target.scissorTest = true;
    gl.setRenderTarget(target);
    this.quad.material = mat;
    this.quad.render(gl);
    target.scissorTest = false;
  }

  /** Run every effect for one view. The hdr target must hold the view as just rendered. */
  run(gl: THREE.WebGLRenderer, hdr: THREE.WebGLRenderTarget, v: FxView) {
    const p = this.params;
    const cam = v.camera;
    const r = v.rect;
    this.near = cam.near;
    this.far = cam.far;
    const W = this.width;
    const H = this.height;
    const P00 = cam.projectionMatrix.elements[0];
    const P11 = cam.projectionMatrix.elements[5];
    _rot.setFromMatrix4(cam.matrixWorld);
    const sunOn = p.sunLight.r + p.sunLight.g + p.sunLight.b > 0.02;
    const shadowMap = v.shadow.map;
    const shadowTex = shadowMap ? shadowMap.depthTexture : null;
    const useVol = sunOn && p.dust > 0 && !!shadowTex;

    // Where the sun is on this view, for the radial shafts.
    _v.copy(v.sunDir).applyMatrix3(_rot.clone().transpose());
    const front = _v.z < -0.02 && sunOn;
    const sunUv = front ? [(_v.x * P00) / -_v.z * 0.5 + 0.5, (_v.y * P11) / -_v.z * 0.5 + 0.5] : [0.5, 0.5];
    // The radial pass pays off when the sun is on-screen or just past the edge.
    const near = front && Math.abs(sunUv[0] - 0.5) < 2.2 && Math.abs(sunUv[1] - 0.5) < 2.2;

    const prevAuto = gl.autoClear;
    gl.autoClear = false;
    const setCommon = (m: THREE.ShaderMaterial) => {
      const u = m.uniforms;
      u.uRect.value.set(r.x / W, r.y / H, r.w / W, r.h / H);
      u.uProjXY.value.set(1 / P00, 1 / P11);
      u.uNearFar.value.set(cam.near, cam.far);
      u.uPix.value.set(1 / r.w, 1 / r.h);
    };

    // 1+2: occlusion and scattered light, half resolution.
    const lm = this.light;
    setCommon(lm);
    const lu = lm.uniforms;
    lu.uCamRot.value.copy(_rot);
    lu.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    lu.uSunDir.value.copy(v.sunDir);
    lu.uSunLight.value.set(p.sunLight.r, p.sunLight.g, p.sunLight.b);
    lu.uSunUv.value.set(sunUv[0], sunUv[1]);
    lu.uAo.value.set(p.aoRadius, 0.5 * r.h * P11, p.aoStrength > 0.001 ? 1 : 0, 0);
    lu.uVol.value.set(useVol ? p.dust : 0, p.dustFall, cam.position.y - 1.5, 110);
    lu.uVol2.value.set(0.6, v.time * 0.35, 0, 0);
    lu.uRad.value.set(p.shafts > 0.001 && near ? p.shafts : 0, 6.0, near ? 1 : 0, 0);
    lu.uAspect.value = r.w / r.h;
    lu.uShadowMat.value.copy(v.shadow.matrix);
    lu.tShadow.value = shadowTex;
    lu.uTime.value = v.time;
    const hx = Math.round(r.x / 2);
    const hy = Math.round(r.y / 2);
    const hw = Math.round((r.x + r.w) / 2) - hx;
    const hh = Math.round((r.y + r.h) / 2) - hy;
    const [a, b, c] = this.half;
    this.pass(gl, lm, a, hx, hy, hw, hh);

    // 3: depth-aware blur, across then down.
    const bm = this.blur;
    setCommon(bm);
    bm.uniforms.tSrc.value = a.texture;
    bm.uniforms.uDir.value.set(1 / hw, 0);
    this.pass(gl, bm, b, hx, hy, hw, hh);
    bm.uniforms.tSrc.value = b.texture;
    bm.uniforms.uDir.value.set(0, 1 / hh);
    this.pass(gl, bm, c, hx, hy, hw, hh);

    // 4: reflections, full resolution.
    const sm = this.ssrMat;
    setCommon(sm);
    const su = sm.uniforms;
    su.tColor.value = hdr.texture;
    su.uProj.value.copy(cam.projectionMatrix);
    su.uCamRot.value.copy(_rot);
    su.uRes.value.set(r.w, r.h);
    su.uSsr.value.set(70, p.reflect, 0, 0);
    this.pass(gl, sm, this.ssr, r.x, r.y, r.w, r.h);

    gl.autoClear = prevAuto;
    this.frames++;
  }

  dispose() {
    for (const r of this.half) r.dispose();
    this.ssr.dispose();
    this.light.dispose();
    this.blur.dispose();
    this.ssrMat.dispose();
    this.quad.dispose();
  }
}
