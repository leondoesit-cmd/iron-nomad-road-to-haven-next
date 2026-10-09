import * as THREE from 'three';
import { atmoUniforms } from './atmosphere';
import { GLOBALS } from './materials';
import { GRAIN, KINDS, type Ejecta } from '../sim/ejecta';
import { SOILS } from '../sim/soil';

/**
 * Draws the soil in the air (`sim/ejecta.ts`): each clump a point sprite the size of its volume, a cluster of grains
 * rather than a ball, streaked along the way it is flying, lit by the sun and fading into the haze like the dust.
 */

const vert = /* glsl */ `
attribute vec3 aVel;
attribute vec4 aLook;
attribute float aSz;
uniform float uScale;
varying vec3 vTint;
varying float vSeed;
varying float vSolid;
varying float vStretch;
varying float vRot;
varying float vPx;
#include <fog_pars_vertex>
void main() {
  vTint = aLook.rgb;
  // The look's last channel is its random, plus 2 for a solid lump (earth, clay, gravel, mud) rather than loose grains.
  vSolid = step( 1.5, aLook.a );
  vSeed = aLook.a - 2.0 * vSolid;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  vec3 motion = ( modelViewMatrix * vec4( aVel, 0.0 ) ).xyz;
  float m = length( motion.xy );
  // Streaked by its own speed across the view, as the eye sees fast grains.
  vStretch = clamp( m * 0.3, 0.0, 4.0 );
  vRot = m > 0.05 ? atan( motion.y, motion.x ) : vSeed * 6.283;
  gl_Position = projectionMatrix * mvPosition;
  // Never under a couple of pixels: a spray far off still shows as specks.
  gl_PointSize = clamp( aSz * uScale * ( 1.0 + vStretch ) / max( 0.1, -mvPosition.z ), 2.0, 64.0 );
  vPx = gl_PointSize;
  #include <fog_vertex>
}`;

const frag = /* glsl */ `
uniform vec3 uLight;
varying vec3 vTint;
varying float vSeed;
varying float vSolid;
varying float vStretch;
varying float vRot;
varying float vPx;
#include <fog_pars_fragment>
float h1( float n ) { return fract( sin( n ) * 43758.5453 ); }
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float s = sin( vRot );
  float k = cos( vRot );
  vec2 p = vec2( c.x * k + c.y * s, -c.x * s + c.y * k );
  // Streaked along the flight: squeeze across it.
  p.y *= 1.0 + vStretch;
  float a = 0.0;
  float lit = 0.0;
  if ( vSolid > 0.5 ) {
    // A solid lump: one ragged clod, lit from above, dark underneath.
    vec2 q = p * vec2( 1.0, 1.0 + vStretch * 0.5 );
    float ang = atan( q.y, q.x );
    float edge = 0.3 + 0.06 * sin( ang * 3.0 + vSeed * 20.0 ) + 0.04 * sin( ang * 7.0 + vSeed * 43.0 );
    a = 1.0 - smoothstep( edge - 0.04, edge, length( q ) );
    lit = 0.3 + 0.38 * clamp( 0.5 - q.y / edge * 0.6, 0.0, 1.0 );
    if ( a < 0.05 ) discard;
    gl_FragColor = vec4( vTint * uLight * lit, a );
    #include <fog_fragment>
    return;
  }
  // Loose grains: too fine to see one by one in flight; a soft smear streaked along its way, with the grain of the sand
  // (or the fine soil) in it, a little see-through, lit from above. Many together make the sheet of a crown or the body of
  // a plume.
  float d = length( p );
  float n = h1( floor( p.x * 9.0 + vSeed * 17.0 ) * 7.0 + floor( p.y * 9.0 ) * 13.0 + vSeed * 31.0 );
  a = ( 1.0 - smoothstep( 0.18, 0.5, d ) ) * ( 0.55 + 0.45 * n ) * 0.8;
  lit = 0.6 + 0.25 * clamp( 0.5 - p.y, 0.0, 1.0 ) + ( n - 0.5 ) * 0.1;
  if ( a < 0.05 ) discard;
  gl_FragColor = vec4( vTint * uLight * lit, a );
  #include <fog_fragment>
}`;

export class SandSpray {
  readonly points: THREE.Points;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private vel: Float32Array;
  private look: Float32Array;
  private size: Float32Array;
  private uniforms: Record<string, THREE.IUniform>;
  private tints = KINDS.map((k) => (k === 'grit' ? ([0.55, 0.54, 0.52] as const) : SOILS[k].tint));
  /** Kinds that fly as lumps rather than a spray of grains. */
  private solid = KINDS.map((k) => GRAIN[k].solid);
  /**
   * How wide a clump of loose grains spreads against its volume: dune sand flies as a fine sheet, broken earth as a dense
   * plume of soil that hangs together.
   */
  private spread = KINDS.map((k) => (k === 'sand' ? 1.7 : k === 'loam' || k === 'clay' ? 3 : 2.6));

  constructor(private ejecta: Ejecta) {
    const n = ejecta.max;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.look = new Float32Array(n * 4);
    this.size = new Float32Array(n);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aLook', new THREE.BufferAttribute(this.look, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSz', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.uniforms = { ...atmoUniforms(), uScale: { value: 800 }, uLight: GLOBALS.uLight };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    // After the dust: grains are seen through the puff they fly out of.
    this.points.renderOrder = 6;
    this.points.visible = false;
    this.points.name = 'ground:spray';
  }

  /** Point sprites are sized for one view's height in pixels and its field of view. */
  setViewScale(viewHeightPx: number, fovDeg: number) {
    this.uniforms.uScale.value = viewHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  /** Once per rendered frame: copy the clumps in flight (`alpha` of a step ahead, along their velocity). */
  update(lead = 0) {
    const e = this.ejecta;
    const n = e.n;
    for (let i = 0; i < n; i++) {
      this.pos[i * 3] = e.px[i] + e.vx[i] * lead;
      this.pos[i * 3 + 1] = e.py[i] + e.vy[i] * lead;
      this.pos[i * 3 + 2] = e.pz[i] + e.vz[i] * lead;
      this.vel[i * 3] = e.vx[i];
      this.vel[i * 3 + 1] = e.vy[i];
      this.vel[i * 3 + 2] = e.vz[i];
      const shade = 0.85 + 0.3 * e.seed[i];
      if (e.tinted[i]) {
        this.look[i * 4] = e.tint[i * 3] * shade;
        this.look[i * 4 + 1] = e.tint[i * 3 + 1] * shade;
        this.look[i * 4 + 2] = e.tint[i * 3 + 2] * shade;
      } else {
        const t = this.tints[e.kind[i]];
        this.look[i * 4] = t[0] * shade;
        this.look[i * 4 + 1] = t[1] * shade;
        this.look[i * 4 + 2] = t[2] * shade;
      }
      const solid = this.solid[e.kind[i]];
      this.look[i * 4 + 3] = e.seed[i] + (solid ? 2 : 0);
      // Loose grains spread into a cluster wider than the clump would be as one lump; a solid piece is its own size.
      this.size[i] = Math.min(0.3, Math.max(solid ? 0.006 : 0.008, Math.cbrt(e.vol[i]) * (solid ? 1.6 : this.spread[e.kind[i]])));
    }
    if (n) {
      for (const [name, size] of [['position', 3], ['aVel', 3], ['aLook', 4], ['aSz', 1]] as const) {
        const a = this.geo.getAttribute(name) as THREE.BufferAttribute;
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * size);
        a.needsUpdate = true;
      }
    }
    this.geo.setDrawRange(0, n);
    this.points.visible = n > 0;
  }

  dispose() {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
    this.points.removeFromParent();
  }
}
