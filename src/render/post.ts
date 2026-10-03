import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { clamp } from '../core/math';
import { ScreenFX, type FxView } from './screenfx';
import { lookActive, type TripView } from './trip';

/**
 * HDR post chain for the split screen: both views render into one multisampled half-float target, then
 * a bloom mip chain and a composite pass (exposure, ACES, grading, per-half vignette, grain) draw it to
 * the canvas. Every pass clamps its taps to the half the pixel belongs to, so one player's muzzle flash
 * never glows into the other player's view.
 *
 * Each half also carries its own trip: hue swim, warp, double vision, kaleidoscope, neon outlines, eyelids and (through a
 * feedback buffer holding the last frame) motion trails. A half that is not tripping costs nothing extra.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const RECTS = /* glsl */ `
uniform vec4 uRectA;
uniform vec4 uRectB;
vec4 rectFor( vec2 uv ) {
  return ( uv.x >= uRectA.x && uv.x <= uRectA.z && uv.y >= uRectA.y && uv.y <= uRectA.w ) ? uRectA : uRectB;
}
`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uPrefilter;
uniform vec2 uThreshold;
varying vec2 vUv;
${RECTS}
vec3 tap( vec2 uv, vec4 r ) {
  return texture2D( tSrc, clamp( uv, r.xy + uTexel, r.zw - uTexel ) ).rgb;
}
void main() {
  vec4 r = rectFor( vUv );
  vec2 t = uTexel;
  vec3 a = tap( vUv + t * vec2( -2.0, 2.0 ), r );
  vec3 b = tap( vUv + t * vec2( 0.0, 2.0 ), r );
  vec3 c = tap( vUv + t * vec2( 2.0, 2.0 ), r );
  vec3 d = tap( vUv + t * vec2( -2.0, 0.0 ), r );
  vec3 e = tap( vUv, r );
  vec3 f = tap( vUv + t * vec2( 2.0, 0.0 ), r );
  vec3 g = tap( vUv + t * vec2( -2.0, -2.0 ), r );
  vec3 h = tap( vUv + t * vec2( 0.0, -2.0 ), r );
  vec3 i = tap( vUv + t * vec2( 2.0, -2.0 ), r );
  vec3 j = tap( vUv + t * vec2( -1.0, 1.0 ), r );
  vec3 k = tap( vUv + t * vec2( 1.0, 1.0 ), r );
  vec3 l = tap( vUv + t * vec2( -1.0, -1.0 ), r );
  vec3 m = tap( vUv + t * vec2( 1.0, -1.0 ), r );
  vec3 col = e * 0.125 + ( a + c + g + i ) * 0.03125 + ( b + d + f + h ) * 0.0625 + ( j + k + l + m ) * 0.125;
  if ( uPrefilter > 0.5 ) {
    float br = max( col.r, max( col.g, col.b ) );
    float soft = clamp( br - uThreshold.x + uThreshold.y, 0.0, 2.0 * uThreshold.y );
    soft = soft * soft / ( 4.0 * uThreshold.y + 1e-4 );
    col *= max( soft, br - uThreshold.x ) / max( br, 1e-4 );
    col = min( col, vec3( 40.0 ) );
  }
  gl_FragColor = vec4( col, 1.0 );
}`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tLow;
uniform sampler2D tCur;
uniform vec2 uTexel;
uniform float uScatter;
varying vec2 vUv;
${RECTS}
vec3 tap( vec2 uv, vec4 r ) {
  return texture2D( tLow, clamp( uv, r.xy + uTexel * 0.5, r.zw - uTexel * 0.5 ) ).rgb;
}
void main() {
  vec4 r = rectFor( vUv );
  vec2 t = uTexel;
  vec3 s = tap( vUv, r ) * 4.0;
  s += ( tap( vUv + vec2( t.x, 0.0 ), r ) + tap( vUv - vec2( t.x, 0.0 ), r ) + tap( vUv + vec2( 0.0, t.y ), r ) + tap( vUv - vec2( 0.0, t.y ), r ) ) * 2.0;
  s += tap( vUv + t, r ) + tap( vUv - t, r ) + tap( vUv + vec2( t.x, -t.y ), r ) + tap( vUv + vec2( -t.x, t.y ), r );
  vec3 cur = texture2D( tCur, vUv ).rgb;
  gl_FragColor = vec4( mix( cur, s / 16.0, uScatter ), 1.0 );
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tPrev;
uniform float uBloom;
uniform float uExposure;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform vec2 uRes;
uniform vec2 uTexel;
uniform float uFade;
uniform float uHasPrev;
uniform vec2 uPhase;
// Per player half, five vec4s each (half A first):
//   0: hue, saturation, warp, chroma   1: double vision, kaleidoscope, tunnel, pulse
//   2: blur, edge, glow, dark          3: tint rgb, brightness
//   4: trail keep, trail zoom, trail hue, on
uniform vec4 uFx[10];
uniform sampler2D tDepth;
uniform sampler2D tFxLight;
uniform sampler2D tFxSsr;
uniform vec2 uFxRes;
uniform vec2 uNearFar;
uniform float uFxOn;
uniform float uAoK;
varying vec2 vUv;
${RECTS}
vec4 gRect;
vec3 rrtOdt( vec3 v ) {
  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
  return a / b;
}
vec3 aces( vec3 c ) {
  const mat3 IN = mat3( 0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777 );
  const mat3 OUT = mat3( 1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602 );
  return clamp( OUT * rrtOdt( IN * c ), 0.0, 1.0 );
}
vec3 toSRGB( vec3 c ) {
  return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) );
}
float hash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
// Rotate a colour's hue about the grey axis.
vec3 hueRot( vec3 c, float a ) {
  const vec3 k = vec3( 0.57735027 );
  float s = sin( a );
  float co = cos( a );
  return c * co + cross( k, c ) * s + k * dot( k, c ) * ( 1.0 - co );
}
vec3 rainbow( float h ) {
  return 0.5 + 0.5 * cos( 6.2831853 * ( vec3( 0.0, 0.33, 0.67 ) + h ) );
}
// Taps clamp to the half the pixel belongs to, so one player's trip never bleeds into the other's view.
vec3 sceneAt( vec2 uv ) {
  return texture2D( tScene, clamp( uv, gRect.xy + uTexel, gRect.zw - uTexel ) ).rgb;
}
float linZ( float d ) {
  return ( uNearFar.x * uNearFar.y ) / ( ( uNearFar.y - uNearFar.x ) * d - uNearFar.y );
}
// The half-resolution AO and scattered light, upsampled with weights that fall off across depth edges, so occlusion never
// leaks from a car onto the ground behind it.
vec4 fxUp( vec2 uv ) {
  vec2 hp = uv * uFxRes - 0.5;
  vec2 base = floor( hp );
  vec2 f = hp - base;
  float zc = linZ( texture2D( tDepth, uv ).r );
  float dzX = dFdx( zc );
  float dzY = dFdy( zc );
  float tol = max( 0.04 * abs( zc ) + 0.12, ( abs( dzX ) + abs( dzY ) ) * 1.5 );
  vec4 sum = vec4( 0.0 );
  float wsum = 0.0;
  for ( int j = 0; j < 2; j++ ) {
    for ( int i = 0; i < 2; i++ ) {
      vec2 tuv = clamp( ( base + vec2( float( i ), float( j ) ) + 0.5 ) / uFxRes, gRect.xy, gRect.zw );
      float zi = linZ( texture2D( tDepth, tuv ).r );
      vec2 dp = ( tuv - uv ) * uRes;
      float zExp = zc + dzX * dp.x + dzY * dp.y;
      float wb = ( i == 0 ? 1.0 - f.x : f.x ) * ( j == 0 ? 1.0 - f.y : f.y );
      float diff = min( abs( zi - zc ), abs( zi - zExp ) );
      float w = wb * exp( - diff / tol ) + 1e-4;
      sum += texture2D( tFxLight, tuv ) * w;
      wsum += w;
    }
  }
  return sum / max( wsum, 1e-4 );
}
float lumaAt( vec2 uv ) {
  return log2( 1.0 + dot( sceneAt( uv ), vec3( 0.2126, 0.7152, 0.0722 ) ) );
}
void main() {
  vec4 r = rectFor( vUv );
  gRect = r;
  bool inA = vUv.x >= uRectA.x && vUv.x <= uRectA.z && vUv.y >= uRectA.y && vUv.y <= uRectA.w;
  int hb = inA ? 0 : 5;
  vec4 f0 = uFx[ hb ];
  vec4 f1 = uFx[ hb + 1 ];
  vec4 f2 = uFx[ hb + 2 ];
  vec4 f3 = uFx[ hb + 3 ];
  vec4 f4 = uFx[ hb + 4 ];
  float ph = inA ? uPhase.x : uPhase.y;
  vec2 span = max( r.zw - r.xy, vec2( 1e-4 ) );
  vec2 ctr = ( r.xy + r.zw ) * 0.5;
  vec2 q0 = ( vUv - ctr ) / span;
  float aspect = span.x * uRes.x / max( span.y * uRes.y, 1.0 );
  vec2 ax = vec2( aspect, 1.0 );
  float rr0 = length( q0 * ax ) / length( ax * 0.5 );
  vec3 col;
  vec3 bloom;
  vec3 edgeAdd = vec3( 0.0 );
  float hueA = 0.0;
  vec2 fxUv = vUv;
  if ( f4.w > 0.5 ) {
    vec2 p = q0 * ax;
    float rr = rr0;
    // Heartbeat: a thump and a slow swell.
    float beat = pow( max( 0.0, sin( ph * 5.4 ) ), 6.0 ) * 0.6 + 0.4 * sin( ph * 1.7 );
    p *= 1.0 - f1.w * 0.018 * beat;
    // Kaleidoscope: fold the angle into mirrored wedges, more the nearer the edge.
    if ( f1.y > 0.001 ) {
      float ang = atan( p.y, p.x );
      float seg = 6.2831853 / ( 5.0 + floor( f1.y * 4.0 ) );
      float a2 = abs( mod( ang + ph * 0.06, seg ) - seg * 0.5 ) + ph * 0.02;
      vec2 pk = length( p ) * vec2( cos( a2 ), sin( a2 ) );
      p = mix( p, pk, clamp( f1.y * 0.85, 0.0, 0.9 ) * smoothstep( 0.1, 0.65, rr ) );
    }
    // Warp: a slow wobble over the whole picture, and ripples that run out from the middle.
    float w = f0.z;
    p += w * 0.014 * vec2( sin( p.y * 9.0 + ph * 1.3 ) + 0.5 * sin( p.y * 21.0 - ph * 2.1 ), cos( p.x * 7.0 + ph * 1.1 ) + 0.5 * cos( p.x * 17.0 + ph * 1.9 ) );
    p *= 1.0 + w * 0.02 * sin( rr * 16.0 - ph * 2.0 );
    vec2 q1 = p / ax;
    vec2 uvw = ctr + q1 * span;
    fxUv = clamp( uvw, r.xy, r.zw );
    // Chromatic aberration, bigger toward the edges.
    float ca = f0.w * 0.014 * ( 0.3 + rr );
    vec2 off = normalize( q1 + vec2( 1e-5 ) ) * ca * span;
    col = vec3( sceneAt( uvw + off ).r, sceneAt( uvw ).g, sceneAt( uvw - off ).b );
    // Double vision: a second image drifting about the first.
    if ( f1.x > 0.001 ) {
      vec2 dd = vec2( cos( ph * 0.43 ), sin( ph * 0.57 ) * 0.5 ) * f1.x * 0.028 * span;
      vec3 col2 = vec3( sceneAt( uvw + dd + off ).r, sceneAt( uvw + dd ).g, sceneAt( uvw + dd - off ).b );
      col = mix( col, col2, 0.5 * clamp( f1.x * 1.5, 0.0, 1.0 ) );
    }
    // Blur: four taps round the sample.
    if ( f2.x > 0.001 ) {
      vec2 bo = vec2( f2.x * 0.006 ) * span;
      col = col * 0.4 + 0.15 * ( sceneAt( uvw + vec2( bo.x, 0.0 ) ) + sceneAt( uvw - vec2( bo.x, 0.0 ) ) + sceneAt( uvw + vec2( 0.0, bo.y ) ) + sceneAt( uvw - vec2( 0.0, bo.y ) ) );
    }
    bloom = texture2D( tBloom, clamp( uvw, gRect.xy, gRect.zw ) ).rgb * ( 1.0 + f2.z * 4.0 );
    // Neon outlines, drifting through the colours.
    if ( f2.y > 0.001 ) {
      vec2 e = uTexel * 1.6;
      float gx = lumaAt( uvw + vec2( e.x, 0.0 ) ) - lumaAt( uvw - vec2( e.x, 0.0 ) );
      float gy = lumaAt( uvw + vec2( 0.0, e.y ) ) - lumaAt( uvw - vec2( 0.0, e.y ) );
      float eg = clamp( length( vec2( gx, gy ) ) * 1.6, 0.0, 1.0 );
      edgeAdd = rainbow( ph * 0.15 + rr * 0.8 + eg * 0.2 ) * eg * f2.y * 1.6;
    }
    // Hue swim: swirls across the picture and over time.
    hueA = f0.x * ( 1.4 * sin( ph * 0.37 ) + 1.1 * sin( rr * 5.0 - ph * 0.8 + q0.x * 2.0 ) );
  } else {
    col = texture2D( tScene, vUv ).rgb;
    bloom = texture2D( tBloom, vUv ).rgb;
  }
  if ( uFxOn > 0.5 ) {
    vec4 fl = fxUp( fxUv );
    // Occlusion dims the ambient light, so it eases off where the picture is already bright (sunlit ground, lamps). The
    // multi-bounce fit stops pale surfaces going muddy in creases.
    float lum = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
    float ao = fl.a;
    ao = max( ao, ( ( ao * 0.586 - 1.516 ) * ao + 1.93 ) * ao );
    col *= mix( 1.0, min( ao, 1.0 ), uAoK * ( 1.0 - 0.72 * smoothstep( 0.45, 2.4, lum ) ) );
    vec4 sr = texture2D( tFxSsr, fxUv );
    col = mix( col, sr.rgb, sr.a );
    float zc = abs( linZ( texture2D( tDepth, fxUv ).r ) );
    float creviceShield = mix( ao * ao, 1.0, smoothstep( 6.0, 50.0, zc ) );
    col += fl.rgb * ( 1.0 - col * 0.35 ) * creviceShield;
  }
  vec3 c = col + bloom * uBloom;
  c = aces( c * uExposure * ( f4.w > 0.5 ? 1.0 + f3.w : 1.0 ) / 0.6 );
  c = toSRGB( c );
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = mix( vec3( l ), c, uSaturation * ( f4.w > 0.5 ? max( 0.0, 1.0 + f0.y ) : 1.0 ) );
  if ( f4.w > 0.5 ) {
    c = hueRot( c, hueA );
    c *= 1.0 + f3.rgb;
    c += edgeAdd;
  }
  c *= mix( uShadowTint, uHighTint, smoothstep( 0.05, 0.75, l ) );
  c = clamp( ( c - 0.5 ) * uContrast + 0.5, 0.0, 1.0 );
  c *= 1.0 - ( uVignette + ( f4.w > 0.5 ? f1.z * 0.6 : 0.0 ) ) * smoothstep( 0.45 - ( f4.w > 0.5 ? f1.z * 0.2 : 0.0 ), 1.05, rr0 );
  if ( f4.w > 0.5 ) {
    // Eyelids closing from top and bottom, and the room going dark.
    float lid = smoothstep( 1.0 - f2.w * 1.15, 1.12 - f2.w * 1.15, abs( q0.y ) * 2.0 );
    c *= ( 1.0 - lid ) * ( 1.0 - f2.w * 0.4 );
    // Trails: the last frame, zoomed a hair and slid round the colour wheel, laid under this one.
    if ( f4.x > 0.001 && uHasPrev > 0.5 ) {
      vec2 puv = clamp( ctr + q0 * ( 1.0 - f4.y ) * span, r.xy, r.zw );
      vec3 prev = hueRot( texture2D( tPrev, puv ).rgb, f4.z );
      c = mix( c, prev, f4.x );
    }
  }
  c += ( hash( vUv * uRes + fract( uTime * 13.17 ) * 97.0 ) - 0.5 ) * uGrain;
  gl_FragColor = vec4( c * uFade, 1.0 );
}`;

const COPY_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform float uFade;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4( texture2D( tSrc, vUv ).rgb * uFade, 1.0 );
}`;

export interface PostParams {
  exposure: number;
  bloom: number;
  bloomThreshold: number;
  bloomScatter: number;
  vignette: number;
  grain: number;
  saturation: number;
  contrast: number;
  shadowTint: THREE.Color;
  highTint: THREE.Color;
}

const LEVELS = 6;

export class PostFX {
  hdr: THREE.WebGLRenderTarget;
  /** The scene's depth, resolved from the multisampled target, for the screen-space effects. */
  readonly depth: THREE.DepthTexture;
  /** Ambient occlusion, volumetric light and reflections. */
  readonly fx: ScreenFX;
  /** Turn the screen-space lighting off (the composite then skips it). */
  fxEnabled = true;
  /** Set once a view has run the screen-space passes this frame. */
  private fxRan = false;
  private down: THREE.WebGLRenderTarget[] = [];
  private up: THREE.WebGLRenderTarget[] = [];
  private quad = new FullScreenQuad();
  private downMat: THREE.ShaderMaterial;
  private upMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private copyMat: THREE.ShaderMaterial;
  /** The last composited frame and the one being drawn, for trails. Allocated only while someone is leaving them. */
  private hist: THREE.WebGLRenderTarget[] = [];
  private histIdx = 0;
  private histValid = false;
  /** Five vec4s per half, in the layout the composite shader reads. */
  private fxVecs = Array.from({ length: 10 }, () => new THREE.Vector4());
  private phase = new THREE.Vector2();
  private rectA = new THREE.Vector4(0, 0, 0.5, 1);
  private rectB = new THREE.Vector4(0.5, 0, 1, 1);
  width = 0;
  height = 0;
  params: PostParams = {
    exposure: 1,
    bloom: 0.02,
    bloomThreshold: 1.6,
    bloomScatter: 0.7,
    vignette: 0.32,
    grain: 0.025,
    saturation: 1.0,
    contrast: 1.08,
    shadowTint: new THREE.Color(0.96, 0.98, 1.04),
    highTint: new THREE.Color(1.03, 1.0, 0.95),
  };

  constructor(samples: number) {
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false };
    this.depth = new THREE.DepthTexture(4, 4);
    this.depth.format = THREE.DepthFormat;
    this.depth.type = THREE.UnsignedIntType;
    this.depth.minFilter = THREE.NearestFilter;
    this.depth.magFilter = THREE.NearestFilter;
    this.hdr = new THREE.WebGLRenderTarget(4, 4, { ...opts, depthBuffer: true, samples, depthTexture: this.depth });
    this.fx = new ScreenFX(this.depth);
    for (let i = 0; i < LEVELS; i++) {
      this.down.push(new THREE.WebGLRenderTarget(4, 4, opts));
      this.up.push(new THREE.WebGLRenderTarget(4, 4, opts));
    }
    const rects = { uRectA: { value: this.rectA }, uRectB: { value: this.rectB } };
    this.downMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 }, uThreshold: { value: new THREE.Vector2(1, 0.5) }, ...rects },
      vertexShader: VERT,
      fragmentShader: DOWN_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.upMat = new THREE.ShaderMaterial({
      uniforms: { tLow: { value: null }, tCur: { value: null }, uTexel: { value: new THREE.Vector2() }, uScatter: { value: 0.7 }, ...rects },
      vertexShader: VERT,
      fragmentShader: UP_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uBloom: { value: 0.06 },
        uExposure: { value: 1 },
        uVignette: { value: 0.3 },
        uGrain: { value: 0.02 },
        uTime: { value: 0 },
        uSaturation: { value: 1 },
        uContrast: { value: 1 },
        uShadowTint: { value: new THREE.Color(1, 1, 1) },
        uHighTint: { value: new THREE.Color(1, 1, 1) },
        uRes: { value: new THREE.Vector2(1, 1) },
        uFade: { value: 1 },
        tPrev: { value: null },
        uHasPrev: { value: 0 },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uPhase: { value: this.phase },
        uFx: { value: this.fxVecs },
        tDepth: { value: this.depth },
        tFxLight: { value: null },
        tFxSsr: { value: null },
        uFxRes: { value: new THREE.Vector2(1, 1) },
        uNearFar: { value: new THREE.Vector2(0.2, 2600) },
        uFxOn: { value: 0 },
        uAoK: { value: 1 },
        ...rects,
      },
      vertexShader: VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uFade: { value: 1 } },
      vertexShader: VERT,
      fragmentShader: COPY_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  /**
   * Set one half's trip for this frame from a `TripView`. `dt` is the real frame time, so trails fade by the clock, not
   * the frame rate.
   */
  setTrip(i: number, t: TripView, dt: number) {
    const l = t.look;
    const o = (i === 0 ? 0 : 1) * 5;
    const on = t.active && lookActive(l);
    this.phase.setComponent(i === 0 ? 0 : 1, t.phase);
    if (!on) {
      for (let k = 0; k < 5; k++) this.fxVecs[o + k].set(0, 0, 0, 0);
      return;
    }
    const keep = l.trail > 0.01 ? Math.exp(-Math.max(dt, 1 / 240) / (l.trail * 0.35)) : 0;
    this.fxVecs[o].set(l.hue, l.sat, l.warp, l.chroma);
    this.fxVecs[o + 1].set(l.dbl, l.kaleido, l.tunnel, l.pulse);
    this.fxVecs[o + 2].set(l.blur, l.edge, l.glow, l.dark);
    this.fxVecs[o + 3].set(l.tintR, l.tintG, l.tintB, l.bright);
    this.fxVecs[o + 4].set(clamp(keep, 0, 0.97), l.trail * 0.006 + l.kaleido * 0.004, l.hue * 0.03, 1);
  }

  private wantTrails() {
    return this.fxVecs[4].x > 0.001 || this.fxVecs[9].x > 0.001;
  }

  private ensureHist(w: number, h: number) {
    if (this.hist.length === 2 && this.hist[0].width === w && this.hist[0].height === h) return;
    for (const t of this.hist) t.dispose();
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false };
    this.hist = [new THREE.WebGLRenderTarget(w, h, opts), new THREE.WebGLRenderTarget(w, h, opts)];
    this.histValid = false;
  }

  setSize(w: number, h: number) {
    w = Math.max(4, Math.round(w));
    h = Math.max(4, Math.round(h));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.hdr.setSize(w, h);
    this.fx.setSize(w, h);
    let lw = w;
    let lh = h;
    for (let i = 0; i < LEVELS; i++) {
      lw = Math.max(2, Math.round(lw / 2));
      lh = Math.max(2, Math.round(lh / 2));
      this.down[i].setSize(lw, lh);
      this.up[i].setSize(lw, lh);
    }
  }

  /** View rects in UV space (origin bottom-left). Pass the same rect twice for a single view. */
  setRects(a: [number, number, number, number], b: [number, number, number, number]) {
    this.rectA.set(...a);
    this.rectB.set(...b);
  }

  /** Run the screen-space lighting for a view that has just been drawn into `hdr`. */
  screenFx(gl: THREE.WebGLRenderer, view: FxView) {
    if (!this.fxEnabled) return;
    this.fx.run(gl, this.hdr, view);
    this.fxRan = true;
  }

  /** Bloom and composite the HDR target to the canvas (or `out`). */
  finish(gl: THREE.WebGLRenderer, time: number, outW: number, outH: number, fade = 1) {
    const p = this.params;
    const prevAuto = gl.autoClear;
    gl.autoClear = false;
    gl.setScissorTest(false);
    // Bloom: downsample chain with a soft threshold on the first tap.
    const dm = this.downMat;
    this.quad.material = dm;
    let src: THREE.Texture = this.hdr.texture;
    let sw = this.width;
    let sh = this.height;
    for (let i = 0; i < LEVELS; i++) {
      dm.uniforms.tSrc.value = src;
      dm.uniforms.uTexel.value.set(1 / sw, 1 / sh);
      dm.uniforms.uPrefilter.value = i === 0 ? 1 : 0;
      dm.uniforms.uThreshold.value.set(p.bloomThreshold, p.bloomThreshold * 0.5);
      gl.setRenderTarget(this.down[i]);
      this.quad.render(gl);
      src = this.down[i].texture;
      sw = this.down[i].width;
      sh = this.down[i].height;
    }
    // Upsample: each level blends the blurred lower level over its own downsample.
    const um = this.upMat;
    this.quad.material = um;
    let low: THREE.WebGLRenderTarget = this.down[LEVELS - 1];
    for (let i = LEVELS - 2; i >= 0; i--) {
      um.uniforms.tLow.value = low.texture;
      um.uniforms.tCur.value = this.down[i].texture;
      um.uniforms.uTexel.value.set(1 / low.width, 1 / low.height);
      um.uniforms.uScatter.value = p.bloomScatter;
      gl.setRenderTarget(this.up[i]);
      this.quad.render(gl);
      low = this.up[i];
    }
    const cm = this.compMat;
    const u = cm.uniforms;
    u.tScene.value = this.hdr.texture;
    u.tBloom.value = this.up[0].texture;
    u.tFxLight.value = this.fx.lightTexture;
    u.tFxSsr.value = this.fx.ssr.texture;
    u.uFxRes.value.set(this.fx.lightWidth, this.fx.lightHeight);
    u.uFxOn.value = this.fxEnabled && this.fxRan ? 1 : 0;
    u.uNearFar.value.set(this.fx.near, this.fx.far);
    u.uAoK.value = this.fx.params.aoStrength;
    this.fxRan = false;
    u.uBloom.value = p.bloom;
    u.uExposure.value = p.exposure;
    u.uVignette.value = p.vignette;
    u.uGrain.value = p.grain;
    u.uTime.value = time;
    u.uSaturation.value = p.saturation;
    u.uContrast.value = p.contrast;
    u.uShadowTint.value.copy(p.shadowTint);
    u.uHighTint.value.copy(p.highTint);
    u.uRes.value.set(outW, outH);
    u.uTexel.value.set(1 / this.width, 1 / this.height);
    this.quad.material = cm;
    if (this.wantTrails()) {
      // Draw into the history buffer (with the previous frame laid under it), then copy that to the screen.
      this.ensureHist(Math.max(4, Math.round(outW)), Math.max(4, Math.round(outH)));
      const prev = this.hist[this.histIdx];
      const next = this.hist[1 - this.histIdx];
      u.uFade.value = 1;
      u.tPrev.value = prev.texture;
      u.uHasPrev.value = this.histValid ? 1 : 0;
      gl.setRenderTarget(next);
      this.quad.render(gl);
      this.copyMat.uniforms.tSrc.value = next.texture;
      this.copyMat.uniforms.uFade.value = fade;
      this.quad.material = this.copyMat;
      gl.setRenderTarget(null);
      this.quad.render(gl);
      this.histIdx = 1 - this.histIdx;
      this.histValid = true;
    } else {
      u.uFade.value = fade;
      u.uHasPrev.value = 0;
      this.histValid = false;
      gl.setRenderTarget(null);
      this.quad.render(gl);
    }
    gl.autoClear = prevAuto;
  }

  dispose() {
    this.hdr.dispose();
    this.depth.dispose();
    this.fx.dispose();
    for (const t of [...this.down, ...this.up, ...this.hist]) t.dispose();
    this.copyMat.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
    this.compMat.dispose();
    this.quad.dispose();
  }
}
