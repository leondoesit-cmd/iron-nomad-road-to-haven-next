import * as THREE from 'three';
import { atmoUniforms } from './atmosphere';
import { GLOBALS } from './materials';
import { shared } from './dispose';

/**
 * Drawing fire: flames, and the burning bed under them.
 *
 * A flame is a few tongues, each a strip that stands on the fuel, turns about its own axis to face the camera and bends
 * downwind along its length (more at the tip, as a real flame does: the hot gas is pushed sideways as it rises). The
 * fragment shader draws the flame itself: a teardrop eaten into by turbulence that scrolls up it at the speed hot gas rises
 * (faster in a small flame, as fire puffs faster the smaller it is), the noise bent sideways more toward the tip so the
 * flame licks and tears into loose tongues. How hot each point is picks its colour off a black-body ramp: white-yellow in the
 * body, orange, a deep red where the edges cool, and soot for the dirty fuels. It is drawn in HDR, premultiplied, so the
 * core blooms at night while the flame still hides a little of what is behind it by day.
 *
 * Under it the bed: charred ground with coals that breathe, lying on the ground's slope.
 */

/** Fuel looks, by the index the shaders take (`FireLook`). */
export const FLAME_KIND = { wood: 0, oil: 1, flare: 2, grass: 3, gas: 4 } as const;
export type FlameKind = keyof typeof FLAME_KIND;

let noiseTex: THREE.DataTexture | null = null;

/** Tileable value-noise octaves in four channels (r, g, b, a at rising frequencies), for the flames and the coals. */
export function flameNoise(): THREE.DataTexture {
  if (noiseTex) return noiseTex;
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  const hash = (x: number, y: number, s: number) => {
    let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const value = (u: number, v: number, period: number, s: number) => {
    const x = u * period;
    const y = v * period;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const w = (a: number) => ((a % period) + period) % period;
    const a = hash(w(ix), w(iy), s);
    const b = hash(w(ix + 1), w(iy), s);
    const c = hash(w(ix), w(iy + 1), s);
    const d = hash(w(ix + 1), w(iy + 1), s);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  const fbm = (u: number, v: number, base: number, s: number) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let p = base;
    for (let o = 0; o < 4; o++) {
      sum += value(u, v, p, s + o * 17) * amp;
      norm += amp;
      amp *= 0.5;
      p *= 2;
    }
    return sum / norm;
  };
  const bases = [3, 4, 6, 8];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      for (let c = 0; c < 4; c++) {
        // Stretch the contrast back out: averaged octaves bunch round the middle.
        const n = fbm(u, v, bases[c], 11 + c * 101);
        data[(y * N + x) * 4 + c] = Math.round(Math.min(1, Math.max(0, (n - 0.5) * 1.7 + 0.5)) * 255);
      }
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  noiseTex = shared(t);
  return t;
}

/** The black-body ramp, shared by the flames and the coals. `kind` follows FLAME_KIND. */
const RAMP = /* glsl */ `
vec3 fireRamp( float T, float kind ) {
  vec3 c = mix( vec3( 0.3, 0.025, 0.0 ), vec3( 0.95, 0.16, 0.015 ), smoothstep( 0.0, 0.3, T ) );
  c = mix( c, vec3( 1.0, 0.42, 0.06 ), smoothstep( 0.25, 0.55, T ) );
  c = mix( c, vec3( 1.0, 0.72, 0.26 ), smoothstep( 0.5, 0.8, T ) );
  c = mix( c, vec3( 1.0, 0.93, 0.74 ), smoothstep( 0.78, 1.0, T ) );
  if ( kind > 1.5 && kind < 2.5 ) {
    // A road flare: strontium red round a white core.
    c = mix( vec3( 0.5, 0.02, 0.03 ), vec3( 1.0, 0.12, 0.1 ), smoothstep( 0.0, 0.5, T ) );
    c = mix( c, vec3( 1.0, 0.75, 0.7 ), smoothstep( 0.75, 1.0, T ) );
  } else if ( kind > 3.5 ) {
    // Gas: blue at the root.
    c = mix( vec3( 0.1, 0.25, 1.0 ), c, smoothstep( 0.35, 0.8, T ) );
  }
  return c;
}
`;

const FLAME_VERT = /* glsl */ `
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
uniform float uTime;
varying vec2 vUv;
varying vec4 vB;
varying vec2 vS;
#include <fog_pars_vertex>
void main() {
  float y = position.y;
  float seed = iA.w;
  float w = iB.x;
  float h = iB.y;
  float t = uTime;
  // The flame breathes: its height swells and drops, and now and then shoots up.
  float br = 0.86 + 0.08 * sin( t * 6.1 + seed * 41.0 ) + 0.06 * sin( t * 11.3 + seed * 17.0 ) + 0.05 * sin( t * 2.3 + seed * 5.0 );
  h *= mix( 1.0, br, iC.z );
  // Wind lean plus the flame's own sway.
  vec2 sway = vec2( sin( t * 2.1 + seed * 31.0 ) + 0.6 * sin( t * 4.7 + seed * 13.0 ), sin( t * 1.7 + seed * 23.0 ) + 0.6 * sin( t * 5.3 + seed * 7.0 ) ) * 0.06 * iC.z;
  vec2 L = iC.xy + sway;
  vec3 c = iA.xyz + vec3( L.x * y * y * h, y * h, L.y * y * y * h );
  vec3 ax = normalize( vec3( L.x * 2.0 * y, 1.0, L.y * 2.0 * y ) );
  vec3 toCam = cameraPosition - c;
  float dc = max( length( toCam ), 1e-3 );
  vec3 right = cross( ax, toCam ) / dc;
  float rl = length( right );
  // Looking straight down a flame its strip would turn edge-on: lean toward the camera's own right instead.
  vec3 camRight = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
  right = normalize( mix( camRight, right / max( rl, 1e-4 ), smoothstep( 0.05, 0.4, rl ) ) );
  // A little wider at the root, where the fuel feeds it.
  vec3 p = c + right * position.x * w * ( 1.0 + 0.25 * ( 1.0 - y ) );
  vUv = vec2( position.x * 2.0, y );
  vB = vec4( w, h, iB.z, iB.w );
  vS = vec2( seed, iC.w );
  vec4 mvPosition = viewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FLAME_FRAG = /* glsl */ `
uniform sampler2D tNoise;
uniform float uTime;
uniform float uOcclude;
varying vec2 vUv;
varying vec4 vB;
varying vec2 vS;
#include <fog_pars_fragment>
${RAMP}
void main() {
  float y = vUv.y;
  float seed = vS.x;
  float heat = vB.z;
  float kind = vB.w;
  // Fire puffs faster the smaller it is (about 1.5 / sqrt(size) times a second), so the turbulence climbs a short flame quickly.
  float ts = uTime * 1.25 * inversesqrt( max( vB.y, 0.25 ) );
  float x = vUv.x;
  // The flame licks from side to side, more toward the tip.
  float wa = texture2D( tNoise, vec2( x * 0.22 + seed * 7.31, y * 0.42 - ts * 0.55 ) ).r - 0.5;
  float wb = texture2D( tNoise, vec2( x * 0.5 + seed * 3.7 + 0.37, y * 0.85 - ts * 1.15 ) ).g - 0.5;
  float xw = x + ( wa * 0.9 + wb * 0.45 ) * ( 0.1 + y * 0.9 );
  // Rising cells of hot gas.
  float n = texture2D( tNoise, vec2( xw * 0.3 + seed * 3.1, y * 0.7 - ts * 0.95 ) ).b * 0.5
    + texture2D( tNoise, vec2( xw * 0.62 - seed, y * 1.4 - ts * 1.7 ) ).a * 0.32
    + texture2D( tNoise, vec2( xw * 1.3 + seed * 0.7, y * 2.8 - ts * 2.9 ) ).r * 0.18;
  // A teardrop: round at the root, drawn out to a point.
  float prof = ( 0.55 + 0.45 * smoothstep( 0.0, 0.22, y ) ) * pow( max( 1.0 - y, 0.0 ), 0.75 );
  float d = abs( xw ) / max( prof, 0.02 );
  // The turbulence tears at the flame more the higher it climbs; the root stays whole.
  float f = ( 1.0 - d ) * 1.3 - ( n - 0.42 ) * ( 0.3 + y * 1.6 ) - y * 0.3;
  if ( f <= 0.0 ) discard;
  // Hottest a little above the root (the very root is starved of air and burns dimmer); it cools as it climbs.
  float T = clamp( f * ( 1.0 - 0.3 * y ) * ( 0.75 + 0.25 * smoothstep( 0.0, 0.22, y ) ) * ( 0.62 + 0.36 * heat ), 0.0, 1.0 );
  vec3 col = fireRamp( T, kind ) * ( 0.35 + 1.2 * T + 3.4 * T * T * T ) * ( 0.45 + 0.55 * heat );
  // Soft at the root (it stands in the fuel) and never cut off by the sides of its strip, however far the noise blows it.
  float a = smoothstep( 0.0, 0.2, f ) * smoothstep( 0.0, 0.12, y ) * ( 1.0 - smoothstep( 0.72, 1.0, abs( x ) ) ) * vS.y;
  float occ = uOcclude;
  // Burning oil and rubber: the cool fringe high up is soot, dark and thick.
  if ( kind > 0.5 && kind < 1.5 ) {
    float soot = smoothstep( 0.35, 0.95, y ) * ( 1.0 - smoothstep( 0.05, 0.45, T ) );
    col *= 1.0 - soot * 0.95;
    occ = mix( occ, 0.9, soot );
  }
  // Grass flames are thin and quick: less body to hide what is behind them.
  if ( kind > 2.5 && kind < 3.5 ) occ *= 0.6;
  #ifdef USE_FOG
    float fogK = 1.0 - ( atmoApply( vec3( 1.0 ) ).g - atmoApply( vec3( 0.0 ) ).g );
    a *= 1.0 - fogK;
  #endif
  gl_FragColor = vec4( col * a, a * occ );
}`;

const BED_VERT = /* glsl */ `
attribute vec4 iA;
attribute vec4 iB;
attribute vec3 iN;
varying vec2 vUv;
varying vec4 vB;
varying vec2 vW;
#include <fog_pars_vertex>
void main() {
  vec3 n = normalize( iN );
  vec3 tx = normalize( cross( abs( n.y ) > 0.9 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 0.0, 1.0, 0.0 ), n ) );
  vec3 tz = cross( n, tx );
  float r = iA.w;
  vec3 p = iA.xyz + n * 0.035 + ( tx * position.x + tz * position.y ) * r * 2.0;
  vUv = position.xy * 2.0;
  vB = iB;
  vW = ( iA.xz + ( tx.xz * position.x + tz.xz * position.y ) * r * 2.0 );
  vec4 mvPosition = viewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const BED_FRAG = /* glsl */ `
uniform sampler2D tNoise;
uniform float uTime;
varying vec2 vUv;
varying vec4 vB;
varying vec2 vW;
#include <fog_pars_fragment>
${RAMP}
void main() {
  float r = length( vUv );
  // A ragged edge, so a burning patch never shows its disc.
  float rim = texture2D( tNoise, vW * 0.21 + vB.y ).g;
  float edge = 1.0 - smoothstep( 0.55 + rim * 0.3, 1.0, r );
  if ( edge <= 0.0 ) discard;
  float heat = vB.x;
  float glow = vB.z;
  // Coals: hot lumps among the ash, breathing as the air reaches them.
  float lump = texture2D( tNoise, vW * 0.9 + vB.y * 3.0 ).b;
  float fine = texture2D( tNoise, vW * 2.3 - vB.y ).a;
  float coal = smoothstep( 0.42, 0.78, lump * 0.7 + fine * 0.3 );
  float breath = texture2D( tNoise, vW * 0.35 + vec2( uTime * 0.07, - uTime * 0.05 ) ).r;
  float T = coal * ( 0.35 + 0.75 * breath ) * glow * ( 1.0 - r * 0.5 );
  vec3 col = fireRamp( clamp( T, 0.0, 1.0 ), vB.w ) * ( 0.2 + 5.0 * T * T ) * T;
  // Char: black where it burned, the glow on top.
  float a = edge * mix( 0.55, 0.92, heat );
  #ifdef USE_FOG
    float fogK = 1.0 - ( atmoApply( vec3( 1.0 ) ).g - atmoApply( vec3( 0.0 ) ).g );
    col *= 1.0 - fogK;
    a *= 1.0 - fogK;
  #endif
  gl_FragColor = vec4( col * edge, a );
}`;

const premultiplied = {
  transparent: true,
  depthWrite: false,
  fog: true,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.ZeroFactor,
  blendDstAlpha: THREE.OneFactor,
} as const;

/** One flame tongue as the fire system lays it out. */
export interface Tongue {
  x: number;
  y: number;
  z: number;
  seed: number;
  /** Width and height, metres. */
  w: number;
  h: number;
  /** 0..1: how hot it burns (colour and brightness). */
  heat: number;
  kind: number;
  /** Where the tip is pushed, per metre of height (x and z). */
  lx: number;
  lz: number;
  /** How much it flickers (0 a steady jet, 1 a living flame) and how much of it shows. */
  flick: number;
  alpha: number;
}

/** Every flame and bed drawn this frame, two instanced meshes. */
export class FireView {
  readonly group = new THREE.Group();
  readonly flames: THREE.Mesh;
  readonly beds: THREE.Mesh;
  private fA: Float32Array;
  private fB: Float32Array;
  private fC: Float32Array;
  private bA: Float32Array;
  private bB: Float32Array;
  private bN: Float32Array;
  private fGeo: THREE.InstancedBufferGeometry;
  private bGeo: THREE.InstancedBufferGeometry;
  private nf = 0;
  private nb = 0;

  constructor(readonly maxFlames = 2400, readonly maxBeds = 700) {
    // A strip of eight rows, so a flame can bend along its height.
    const rows = 8;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let r = 0; r <= rows; r++) {
      const y = r / rows;
      pos.push(-0.5, y, 0, 0.5, y, 0);
      if (r < rows) {
        const a = r * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.fGeo = new THREE.InstancedBufferGeometry();
    this.fGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.fGeo.setIndex(idx);
    this.fA = new Float32Array(maxFlames * 4);
    this.fB = new Float32Array(maxFlames * 4);
    this.fC = new Float32Array(maxFlames * 4);
    this.fGeo.setAttribute('iA', new THREE.InstancedBufferAttribute(this.fA, 4).setUsage(THREE.DynamicDrawUsage));
    this.fGeo.setAttribute('iB', new THREE.InstancedBufferAttribute(this.fB, 4).setUsage(THREE.DynamicDrawUsage));
    this.fGeo.setAttribute('iC', new THREE.InstancedBufferAttribute(this.fC, 4).setUsage(THREE.DynamicDrawUsage));
    this.fGeo.instanceCount = 0;
    const fMat = new THREE.ShaderMaterial({
      uniforms: { ...atmoUniforms(), tNoise: { value: flameNoise() }, uTime: GLOBALS.uTime, uOcclude: { value: 0.55 } },
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      side: THREE.DoubleSide,
      ...premultiplied,
    });
    this.flames = new THREE.Mesh(this.fGeo, fMat);
    this.flames.frustumCulled = false;
    // After the beds, before the smoke that rises out of it.
    this.flames.renderOrder = 4;

    this.bGeo = new THREE.InstancedBufferGeometry();
    this.bGeo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    this.bGeo.setIndex([0, 2, 1, 0, 3, 2]);
    this.bA = new Float32Array(maxBeds * 4);
    this.bB = new Float32Array(maxBeds * 4);
    this.bN = new Float32Array(maxBeds * 3);
    this.bGeo.setAttribute('iA', new THREE.InstancedBufferAttribute(this.bA, 4).setUsage(THREE.DynamicDrawUsage));
    this.bGeo.setAttribute('iB', new THREE.InstancedBufferAttribute(this.bB, 4).setUsage(THREE.DynamicDrawUsage));
    this.bGeo.setAttribute('iN', new THREE.InstancedBufferAttribute(this.bN, 3).setUsage(THREE.DynamicDrawUsage));
    this.bGeo.instanceCount = 0;
    const bMat = new THREE.ShaderMaterial({
      uniforms: { ...atmoUniforms(), tNoise: { value: flameNoise() }, uTime: GLOBALS.uTime },
      vertexShader: BED_VERT,
      fragmentShader: BED_FRAG,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
      ...premultiplied,
    });
    this.beds = new THREE.Mesh(this.bGeo, bMat);
    this.beds.frustumCulled = false;
    this.beds.renderOrder = 3;
    this.group.add(this.beds, this.flames);
    this.group.visible = false;
  }

  begin() {
    this.nf = 0;
    this.nb = 0;
  }

  /** Room left for tongues this frame. */
  get flameRoom(): number {
    return this.maxFlames - this.nf;
  }

  flame(t: Tongue) {
    if (this.nf >= this.maxFlames) return;
    const i = this.nf++ * 4;
    const a = this.fA;
    const b = this.fB;
    const c = this.fC;
    a[i] = t.x;
    a[i + 1] = t.y;
    a[i + 2] = t.z;
    a[i + 3] = t.seed;
    b[i] = t.w;
    b[i + 1] = t.h;
    b[i + 2] = t.heat;
    b[i + 3] = t.kind;
    c[i] = t.lx;
    c[i + 1] = t.lz;
    c[i + 2] = t.flick;
    c[i + 3] = t.alpha;
  }

  /** A burning bed: centre, radius, the ground's normal there, how charred (0..1), how hot its coals glow (0..1). */
  bed(x: number, y: number, z: number, r: number, nx: number, ny: number, nz: number, char: number, glow: number, seed: number, kind: number) {
    if (this.nb >= this.maxBeds) return;
    const k = this.nb++;
    const i = k * 4;
    this.bA[i] = x;
    this.bA[i + 1] = y;
    this.bA[i + 2] = z;
    this.bA[i + 3] = r;
    this.bB[i] = char;
    this.bB[i + 1] = seed;
    this.bB[i + 2] = glow;
    this.bB[i + 3] = kind;
    this.bN[k * 3] = nx;
    this.bN[k * 3 + 1] = ny;
    this.bN[k * 3 + 2] = nz;
  }

  end() {
    const up = (geo: THREE.InstancedBufferGeometry, name: string, n: number) => {
      const at = geo.getAttribute(name) as THREE.InstancedBufferAttribute;
      at.clearUpdateRanges();
      if (n > 0) {
        at.addUpdateRange(0, n * at.itemSize);
        at.needsUpdate = true;
      }
    };
    up(this.fGeo, 'iA', this.nf);
    up(this.fGeo, 'iB', this.nf);
    up(this.fGeo, 'iC', this.nf);
    up(this.bGeo, 'iA', this.nb);
    up(this.bGeo, 'iB', this.nb);
    up(this.bGeo, 'iN', this.nb);
    this.fGeo.instanceCount = this.nf;
    this.bGeo.instanceCount = this.nb;
    this.flames.visible = this.nf > 0;
    this.beds.visible = this.nb > 0;
    this.group.visible = this.nf + this.nb > 0;
  }

  get flameCount(): number {
    return this.nf;
  }

  get bedCount(): number {
    return this.nb;
  }

  dispose() {
    this.fGeo.dispose();
    this.bGeo.dispose();
    (this.flames.material as THREE.Material).dispose();
    (this.beds.material as THREE.Material).dispose();
  }
}
