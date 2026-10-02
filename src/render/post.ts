import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * HDR post chain for the split screen: both views render into one multisampled half-float target, then
 * a bloom mip chain and a composite pass (exposure, ACES, grading, per-half vignette, grain) draw it to
 * the canvas. Every pass clamps its taps to the half the pixel belongs to, so one player's muzzle flash
 * never glows into the other player's view.
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
uniform float uFade;
varying vec2 vUv;
${RECTS}
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
void main() {
  vec3 c = texture2D( tScene, vUv ).rgb;
  c += texture2D( tBloom, vUv ).rgb * uBloom;
  c = aces( c * uExposure / 0.6 );
  c = toSRGB( c );
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = mix( vec3( l ), c, uSaturation );
  c *= mix( uShadowTint, uHighTint, smoothstep( 0.05, 0.75, l ) );
  c = clamp( ( c - 0.5 ) * uContrast + 0.5, 0.0, 1.0 );
  vec4 r = rectFor( vUv );
  vec2 q = ( vUv - r.xy ) / max( r.zw - r.xy, vec2( 1e-4 ) ) - 0.5;
  float aspect = ( r.z - r.x ) * uRes.x / max( ( r.w - r.y ) * uRes.y, 1.0 );
  vec2 dq = q * vec2( aspect, 1.0 );
  float rv = length( dq ) / length( vec2( aspect, 1.0 ) * 0.5 );
  c *= 1.0 - uVignette * smoothstep( 0.45, 1.05, rv );
  c += ( hash( vUv * uRes + fract( uTime * 13.17 ) * 97.0 ) - 0.5 ) * uGrain;
  gl_FragColor = vec4( c * uFade, 1.0 );
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
  private down: THREE.WebGLRenderTarget[] = [];
  private up: THREE.WebGLRenderTarget[] = [];
  private quad = new FullScreenQuad();
  private downMat: THREE.ShaderMaterial;
  private upMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private rectA = new THREE.Vector4(0, 0, 0.5, 1);
  private rectB = new THREE.Vector4(0.5, 0, 1, 1);
  width = 0;
  height = 0;
  params: PostParams = {
    exposure: 1,
    bloom: 0.03,
    bloomThreshold: 1.6,
    bloomScatter: 0.7,
    vignette: 0.32,
    grain: 0.025,
    saturation: 1.0,
    contrast: 1.04,
    shadowTint: new THREE.Color(0.96, 0.98, 1.04),
    highTint: new THREE.Color(1.03, 1.0, 0.95),
  };

  constructor(samples: number) {
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false };
    this.hdr = new THREE.WebGLRenderTarget(4, 4, { ...opts, depthBuffer: true, samples });
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
        ...rects,
      },
      vertexShader: VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  setSize(w: number, h: number) {
    w = Math.max(4, Math.round(w));
    h = Math.max(4, Math.round(h));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.hdr.setSize(w, h);
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
    u.uFade.value = fade;
    this.quad.material = cm;
    gl.setRenderTarget(null);
    this.quad.render(gl);
    gl.autoClear = prevAuto;
  }

  dispose() {
    this.hdr.dispose();
    for (const t of [...this.down, ...this.up]) t.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
    this.compMat.dispose();
    this.quad.dispose();
  }
}
