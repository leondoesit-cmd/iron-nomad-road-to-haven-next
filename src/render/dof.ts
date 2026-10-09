import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { DEPTH_GLSL } from './depth';
import { dofActive, noDof, type DofView } from './sights';

/**
 * Depth of field for the split screen, at half resolution, for what the eye does behind the sights (`sights.ts`): the near
 * blur of a gun the eye is looking past, and the out-of-focus world round a scope's eyepiece. Two passes:
 *
 * 1. Prefilter: each half-resolution pixel takes the four scene pixels under it (weighted down by brightness, so a lone
 *    hot pixel does not turn into a flashing disc) and works out its circle of confusion from their depth, the larger of the
 *    four so a soft near edge spreads out over what is behind it.
 * 2. Gather: a spiral of taps out to the largest blur in that half. Each tap counts where its own circle reaches back to
 *    this pixel, so a blurred gun spills soft over the sharp world behind it; a tap that lies behind this pixel may not spread
 *    further than this pixel's own blur, so a sharp front sight never takes on the blurred world round it. The alpha says
 *    how much of the blurred picture the composite should use.
 *
 * Every tap clamps to its own half, so one player's blur never reaches into the other's view. A frame where neither half
 * aims costs nothing: the passes do not run.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const COMMON = /* glsl */ `
uniform vec4 uRectA;
uniform vec4 uRectB;
uniform sampler2D tDepth;
uniform vec2 uDepthTexel;
uniform vec2 uNearFar;
// Per half, two vec4s (half A first): near0, near1, near blur (px), sharp middle; scope blur (px), scope radius, aspect, -.
uniform vec4 uP[ 4 ];
varying vec2 vUv;
${DEPTH_GLSL}
bool inHalfA( vec2 uv ) {
  return uv.x >= uRectA.x && uv.x <= uRectA.z && uv.y >= uRectA.y && uv.y <= uRectA.w;
}
// Depth at the middle of the depth pixel under uv (the buffer is unfiltered; between two pixels rounding would pick one
// in bands), as metres ahead of the eye.
float distAt( vec2 uv ) {
  float d = texture2D( tDepth, ( floor( uv / uDepthTexel + 0.25 ) + 0.5 ) * uDepthTexel ).r;
  if ( depthIsSky( d ) ) return 1e5;
  return -depthViewZ( d, uNearFar );
}
`;

const PREFILTER_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
${COMMON}
float cocAt( vec2 uv, float z, vec4 r, vec4 p0, vec4 p1 ) {
  vec2 span = r.zw - r.xy;
  vec2 q = ( ( uv - r.xy ) / span - 0.5 ) * 2.0 * vec2( p1.z, 1.0 );
  float rr = length( q );
  float nearC = p0.z * ( 1.0 - smoothstep( p0.x, p0.y, z ) );
  if ( p0.w > 0.0 ) nearC *= smoothstep( p0.w, p0.w * 3.0, rr );
  float scopeC = p1.y > 0.0 ? p1.x * smoothstep( p1.y * 0.96, p1.y * 1.1, rr ) : 0.0;
  return max( nearC, scopeC );
}
void main() {
  bool a = inHalfA( vUv );
  vec4 r = a ? uRectA : uRectB;
  vec4 p0 = uP[ a ? 0 : 2 ];
  vec4 p1 = uP[ a ? 1 : 3 ];
  vec2 lo = r.xy + uTexel * 0.5;
  vec2 hi = r.zw - uTexel * 0.5;
  vec3 sum = vec3( 0.0 );
  float wsum = 0.0;
  float coc = 0.0;
  for ( int j = 0; j < 2; j++ ) {
    for ( int i = 0; i < 2; i++ ) {
      vec2 uv = clamp( vUv + ( vec2( float( i ), float( j ) ) - 0.5 ) * uTexel, lo, hi );
      vec3 c = texture2D( tSrc, uv ).rgb;
      float w = 1.0 / ( 1.0 + dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ) );
      sum += c * w;
      wsum += w;
      coc = max( coc, cocAt( uv, distAt( uv ), r, p0, p1 ) );
    }
  }
  gl_FragColor = vec4( sum / max( wsum, 1e-5 ), coc );
}`;

const GATHER_FRAG = /* glsl */ `
uniform sampler2D tA;
uniform vec2 uTexel;
${COMMON}
const int TAPS = 44;
float ign( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}
void main() {
  bool a = inHalfA( vUv );
  vec4 r = a ? uRectA : uRectB;
  vec4 p0 = uP[ a ? 0 : 2 ];
  vec4 p1 = uP[ a ? 1 : 3 ];
  float maxR = max( p0.z, p1.x );
  vec4 c0 = texture2D( tA, vUv );
  if ( maxR < 0.35 ) {
    gl_FragColor = vec4( c0.rgb, 0.0 );
    return;
  }
  vec2 lo = r.xy + uTexel * 0.5;
  vec2 hi = r.zw - uTexel * 0.5;
  float cc = c0.a;
  float zc = distAt( vUv );
  vec3 acc = c0.rgb;
  float tot = 1.0;
  float cover = 0.0;
  float rot = ign( gl_FragCoord.xy ) * 6.2831853;
  for ( int i = 0; i < TAPS; i++ ) {
    float fi = float( i ) + 0.5;
    float rr = maxR * sqrt( fi / float( TAPS ) );
    float an = fi * 2.3999632 + rot;
    vec2 uv = clamp( vUv + vec2( cos( an ), sin( an ) ) * rr * uTexel, lo, hi );
    vec4 s = texture2D( tA, uv );
    float sc = s.a;
    float zs = distAt( uv );
    bool behind = zs > zc * 1.03 + 0.02;
    if ( behind ) sc = min( sc, cc * 2.0 );
    float m = smoothstep( rr - 1.0, rr + 0.75, sc );
    acc += mix( acc / tot, s.rgb, m );
    tot += 1.0;
    if ( !behind ) cover = max( cover, m * smoothstep( 0.4, 1.6, sc ) );
  }
  gl_FragColor = vec4( acc / tot, max( smoothstep( 0.25, 1.4, cc ), cover ) );
}`;

export class DepthOfField {
  /** Half-resolution colour with each pixel's blur (px) in alpha, and the blurred picture with how much to use in alpha. */
  private a: THREE.WebGLRenderTarget;
  private b: THREE.WebGLRenderTarget;
  private quad = new FullScreenQuad();
  private pre: THREE.ShaderMaterial;
  private gather: THREE.ShaderMaterial;
  /** Two vec4s per half, as the shaders read them. */
  private params = Array.from({ length: 4 }, () => new THREE.Vector4());
  /** Each half's depth of field this frame, in the order of the post chain's rects. */
  readonly views: [DofView, DofView] = [noDof(), noDof()];
  /** Each half's aspect (width over height), for round discs. */
  readonly aspect = new THREE.Vector2(1, 1);
  /** Set by `run` when it drew this frame, for the composite. */
  ran = false;
  width = 0;
  height = 0;

  constructor(rects: { uRectA: { value: THREE.Vector4 }; uRectB: { value: THREE.Vector4 } }, depth: THREE.DepthTexture) {
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false };
    this.a = new THREE.WebGLRenderTarget(4, 4, opts);
    this.b = new THREE.WebGLRenderTarget(4, 4, opts);
    const shared = {
      ...rects,
      tDepth: { value: depth },
      uDepthTexel: { value: new THREE.Vector2(1, 1) },
      uNearFar: { value: new THREE.Vector2(0.2, 2600) },
      uP: { value: this.params },
    };
    this.pre = new THREE.ShaderMaterial({
      uniforms: { ...shared, tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: PREFILTER_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.gather = new THREE.ShaderMaterial({
      uniforms: { ...shared, tA: { value: this.a.texture }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: GATHER_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  /** The blurred picture (rgb) and how much of it to use (alpha), valid when `ran`. */
  get texture(): THREE.Texture {
    return this.b.texture;
  }

  /** Whether either half wants any blur this frame. */
  get wanted(): boolean {
    return dofActive(this.views[0]) || dofActive(this.views[1]);
  }

  setSize(w: number, h: number) {
    const hw = Math.max(2, Math.round(w / 2));
    const hh = Math.max(2, Math.round(h / 2));
    if (hw === this.width && hh === this.height) return;
    this.width = hw;
    this.height = hh;
    this.a.setSize(hw, hh);
    this.b.setSize(hw, hh);
  }

  /**
   * Blur the scene in `src` (full resolution) by its depth for the halves that want it. `fullW`/`fullH` are the scene's
   * size, `viewH` each half's height in scene pixels (for blur sized as a share of the view).
   */
  run(gl: THREE.WebGLRenderer, src: THREE.Texture, fullW: number, fullH: number, near: number, far: number, viewH: [number, number]) {
    this.ran = false;
    if (!this.wanted) return;
    // Blur radii in half-resolution pixels.
    for (let i = 0; i < 2; i++) {
      const d = this.views[i];
      const px = viewH[i] * 0.5;
      const asp = i === 0 ? this.aspect.x : this.aspect.y;
      this.params[i * 2].set(d.near0, Math.max(d.near1, d.near0 + 0.01), d.nearCoc * px, d.keep);
      this.params[i * 2 + 1].set(d.scopeCoc * px, d.scopeR, asp, 0);
    }
    for (const m of [this.pre, this.gather]) {
      m.uniforms.uNearFar.value.set(near, far);
      m.uniforms.uDepthTexel.value.set(1 / fullW, 1 / fullH);
    }
    const prevTarget = gl.getRenderTarget();
    this.pre.uniforms.tSrc.value = src;
    this.pre.uniforms.uTexel.value.set(1 / fullW, 1 / fullH);
    this.quad.material = this.pre;
    gl.setRenderTarget(this.a);
    this.quad.render(gl);
    this.gather.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.quad.material = this.gather;
    gl.setRenderTarget(this.b);
    this.quad.render(gl);
    gl.setRenderTarget(prevTarget);
    this.ran = true;
  }

  dispose() {
    this.a.dispose();
    this.b.dispose();
    this.pre.dispose();
    this.gather.dispose();
    this.quad.dispose();
  }
}
