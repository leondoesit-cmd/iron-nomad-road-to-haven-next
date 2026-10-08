import * as THREE from 'three';
import { atmoUniforms } from './atmosphere';
import { GLOBALS } from './materials';
import { COPLANAR, DEPTH_UNIFORMS, PULL, coplanarOffset, depthPullGlsl } from './depth';

/**
 * Marks left on the world and kept: blood that sprays onto walls and pools on the road, and the holes bullets leave.
 * One instanced quad per mark in a ring buffer, so a long fight costs a single draw call and the oldest marks give way to
 * the newest. Blood is wet and bright when it lands and dries to a dark brown over the next minute.
 */

/** Cells of the atlas, 4 across and 3 down. */
export const CELL = { splat0: 0, splat1: 1, splat2: 2, splat3: 3, spray: 4, drops: 5, scar: 6, pool: 7, hole: 8, splinter: 9, scuff: 10, crack: 11 } as const;

const ATLAS_W = 4;
const ATLAS_H = 3;
const PX = 64;

const vert = /* glsl */ `
attribute vec4 aParam; // atlas cell, opacity, born (scene seconds), negative spread seconds / 1 for permanent marks
uniform float uSceneTime;
uniform float uPullStep;
attribute vec3 aTint;
varying vec2 vUv;
varying vec4 vParam;
varying vec3 vTint;
varying float vDepth;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vParam = aParam;
  vTint = aTint;
  float spread = aParam.w < 0.0 ? mix( 0.22, 1.0, smoothstep( 0.0, -aParam.w, max( 0.0, uSceneTime - aParam.z ) ) ) : 1.0;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( position.xy * spread, position.z, 1.0 );
  vDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  // Nearer the eye than any road layer under it, however far off (see depth.ts).
  ${depthPullGlsl(PULL.decal.toFixed(1))}
  #include <fog_vertex>
}`;

const frag = /* glsl */ `
uniform sampler2D tAtlas;
uniform vec3 uLight;
uniform float uSceneTime;
varying vec2 vUv;
varying vec4 vParam;
varying vec3 vTint;
varying float vDepth;
#include <fog_pars_fragment>
void main() {
  float cell = floor( vParam.x + 0.5 );
  vec2 origin = vec2( mod( cell, ${ATLAS_W}.0 ), floor( cell / ${ATLAS_W}.0 ) );
  vec2 uv = ( origin + clamp( vUv, 0.01, 0.99 ) ) / vec2( ${ATLAS_W}.0, ${ATLAS_H}.0 );
  vec4 t = texture2D( tAtlas, uv );
  float age = max( 0.0, uSceneTime - vParam.z );
  // Fresh blood is bright red and glossy; over a minute it goes dark and dull. Holes do not dry.
  float dry = vParam.w > 0.5 ? 0.0 : smoothstep( 1.0, 70.0, age );
  vec3 col = mix( vTint, vTint * vec3( 0.34, 0.5, 0.52 ), dry );
  vec2 glintUv = vUv - vec2( 0.38, 0.61 );
  float sheen = exp( -dot( glintUv * vec2( 1.0, 2.8 ), glintUv * vec2( 1.0, 2.8 ) ) * 55.0 );
  float gloss = vParam.w > 0.5 ? 0.0 : ( 1.0 - dry ) * t.g * ( 0.025 + sheen * 0.14 );
  float a = t.a * vParam.y * ( 1.0 - smoothstep( 110.0, 170.0, vDepth ) );
  if ( a < 0.01 ) discard;
  // The blue channel is the dark of a pit: a bullet hole's core, the black of a crack.
  vec3 lit = col * ( 0.55 + t.r * 0.5 ) * uLight + gloss;
  gl_FragColor = vec4( mix( lit, vec3( 0.012, 0.011, 0.01 ) * uLight, t.b ), a );
  #include <fog_fragment>
}`;

/** A tiny seeded generator so the atlas is the same every run. */
function lcg(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Draw one blob with a ragged edge into a cell: alpha in `a`, a shading term in `r` and a glint in `g`. */
function blob(buf: Uint8Array, cx: number, cy: number, r: number, rnd: () => number, stretch = 1, angle = 0) {
  const lobes = 7;
  const ph: number[] = [];
  const am: number[] = [];
  for (let i = 0; i < lobes; i++) {
    ph.push(rnd() * 6.28);
    am.push(0.1 + rnd() * 0.22);
  }
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const reach = Math.ceil(r * Math.max(1, stretch) * 1.7) + 2;
  for (let y = Math.max(0, Math.floor(cy - reach)); y < Math.min(PX, Math.ceil(cy + reach)); y++) {
    for (let x = Math.max(0, Math.floor(cx - reach)); x < Math.min(PX, Math.ceil(cx + reach)); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = (dx * ca + dy * sa) / stretch;
      const v = -dx * sa + dy * ca;
      const d = Math.hypot(u, v);
      const th = Math.atan2(v, u);
      let edge = r;
      for (let i = 0; i < lobes; i++) edge *= 1 + (am[i] / (1 + i * 0.6)) * Math.sin(th * (i + 2) + ph[i]);
      const k = 1 - d / Math.max(1, edge);
      if (k <= 0) continue;
      const a = Math.min(1, k * 4);
      const i4 = (y * PX + x) * 4;
      if (a * 255 > buf[i4 + 3]) {
        buf[i4 + 3] = Math.round(a * 255);
        buf[i4] = Math.round(120 + 135 * Math.min(1, k * 1.6));
        buf[i4 + 1] = Math.round(255 * Math.max(0, k - 0.55) * 1.8);
      }
    }
  }
}


/** Paint a pixel if it is more opaque than what is there: shade in r, glint in g, pit-dark in b. */
function px(buf: Uint8Array, x: number, y: number, shade: number, glint: number, dark: number, alpha: number) {
  if (x < 0 || y < 0 || x >= PX || y >= PX) return;
  const i = (y * PX + x) * 4;
  const a = Math.round(Math.min(1, alpha) * 255);
  if (a <= buf[i + 3]) return;
  buf[i] = shade;
  buf[i + 1] = glint;
  buf[i + 2] = dark;
  buf[i + 3] = a;
}

/** A thin ragged line out from a point, fading toward its end. */
function streak(buf: Uint8Array, cx: number, cy: number, angle: number, from: number, len: number, width: number, shade: number, dark: number, rnd: () => number) {
  let a = angle;
  let x = cx + Math.cos(a) * from;
  let y = cy + Math.sin(a) * from;
  const steps = Math.ceil(len);
  for (let s = 0; s < steps; s++) {
    a += (rnd() - 0.5) * 0.35;
    x += Math.cos(a);
    y += Math.sin(a);
    const f = 1 - s / steps;
    const r = width * (0.4 + 0.6 * f);
    for (let oy = -Math.ceil(r); oy <= Math.ceil(r); oy++) {
      for (let ox = -Math.ceil(r); ox <= Math.ceil(r); ox++) {
        if (Math.hypot(ox, oy) <= r) px(buf, Math.round(x) + ox, Math.round(y) + oy, shade, 0, dark, 0.35 + 0.65 * f);
      }
    }
  }
}

/**
 * A bullet hole seen square-on: a black pit, a ragged rim of exposed, paler material around it and splinters thrown out
 * along the grain. `big` is the exit side or a heavy round: a wider crater with longer splinters.
 */
function holeCell(buf: Uint8Array, seed: number, big: boolean) {
  const rnd = lcg(seed);
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  const haloR = big ? 19 : 13;
  const coreR = big ? 8.5 : 6.4;
  const edge = (th: number, base: number) => base * (1 + 0.2 * Math.sin(th * 3 + ph[0]) + 0.14 * Math.sin(th * 5 + ph[1]) + 0.1 * Math.sin(th * 9 + ph[2]));
  for (let y = 0; y < PX; y++) {
    for (let x = 0; x < PX; x++) {
      const dx = x + 0.5 - 32;
      const dy = y + 0.5 - 32;
      const d = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      const h = edge(th, haloR);
      const c = edge(th + 1.7, coreR);
      if (d < c) px(buf, x, y, 20, 0, 255, 1);
      else if (d < c + 2) px(buf, x, y, 70, 0, 120, 1);
      else if (d < h) {
        const k = 1 - d / h;
        px(buf, x, y, Math.round(190 + 65 * k), k > 0.55 ? 160 : 0, 0, Math.min(1, k * 2.6) * 0.92);
      }
    }
  }
  // Splinters of the material, longer on the exit side.
  const n = big ? 11 : 7;
  for (let i = 0; i < n; i++) streak(buf, 32, 32, rnd() * 6.28, coreR + 1, haloR * (big ? 1.5 : 1.2) * (0.6 + rnd() * 0.7), big ? 1.5 : 1.1, 255, 0, rnd);
}

/** A pit in earth, stone or concrete: soft dark dust thrown round a small hole, chips radiating. */
function scuffCell(buf: Uint8Array, seed: number) {
  const rnd = lcg(seed);
  for (let y = 0; y < PX; y++) {
    for (let x = 0; x < PX; x++) {
      const d = Math.hypot(x + 0.5 - 32, y + 0.5 - 32);
      const k = 1 - d / 17;
      if (k > 0) px(buf, x, y, Math.round(110 + 70 * rnd()), 0, d < 5 ? Math.round(255 * (1 - d / 5)) : 0, Math.min(1, k * 1.6) * 0.78);
    }
  }
  for (let i = 0; i < 9; i++) streak(buf, 32, 32, rnd() * 6.28, 6, 10 + rnd() * 14, 1, 200, 0, rnd);
}

/**
 * Where a round tore the bark off a tree: a ragged patch of pale wood stretched along the grain (the cell's x, laid along the
 * trunk), torn fibres running out along it, a dark lip of curled bark round its edge and a dark hole in the middle.
 */
function scarCell(buf: Uint8Array, seed: number) {
  const rnd = lcg(seed);
  blob(buf, 32, 32, 12, rnd, 1.75, (rnd() - 0.5) * 0.15);
  // The torn lip: the outer rim of the patch goes dark.
  for (let i = 0; i < PX * PX; i++) {
    const a = buf[i * 4 + 3];
    if (a > 0 && a < 150) {
      buf[i * 4] = 80;
      buf[i * 4 + 2] = 120;
    }
  }
  for (let i = 0; i < 9; i++) {
    const side = rnd() < 0.5 ? 0 : Math.PI;
    streak(buf, 32, 32 + (rnd() - 0.5) * 10, side + (rnd() - 0.5) * 0.25, 6, 12 + rnd() * 16, 0.8 + rnd() * 0.6, 245, 0, rnd);
  }
  for (let y = 0; y < PX; y++) {
    for (let x = 0; x < PX; x++) {
      const d = Math.hypot((x + 0.5 - 32) / 1.6, y + 0.5 - 32);
      if (d < 3.6) px(buf, x, y, 30, 0, 255, 1);
      else if (d < 5.5) px(buf, x, y, 110, 0, 150, 1);
    }
  }
}

/** A web of cracks from a point: what a wall looks like before it gives. */
function crackCell(buf: Uint8Array, seed: number) {
  const rnd = lcg(seed);
  const rays = 6 + Math.floor(rnd() * 3);
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * 6.28 + (rnd() - 0.5) * 0.5;
    const len = 18 + rnd() * 12;
    streak(buf, 32, 32, a, 2, len, 1.1, 50, 255, rnd);
    // A branch off partway along.
    if (rnd() < 0.7) {
      const from = 6 + rnd() * 10;
      streak(buf, 32 + Math.cos(a) * from, 32 + Math.sin(a) * from, a + (rnd() < 0.5 ? 1 : -1) * (0.5 + rnd() * 0.5), 0, 8 + rnd() * 8, 0.9, 50, 255, rnd);
    }
  }
  // Crushed in the middle.
  for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) if (Math.hypot(x + 0.5 - 32, y + 0.5 - 32) < 3.4) px(buf, x, y, 30, 0, 255, 1);
}

function atlas(): THREE.DataTexture {
  const W = PX * ATLAS_W;
  const H = PX * ATLAS_H;
  const out = new Uint8Array(W * H * 4);
  const cell = new Uint8Array(PX * PX * 4);
  const put = (index: number) => {
    const ox = (index % ATLAS_W) * PX;
    const oy = Math.floor(index / ATLAS_W) * PX;
    for (let y = 0; y < PX; y++) {
      const src = y * PX * 4;
      const dst = ((oy + y) * W + ox) * 4;
      out.set(cell.subarray(src, src + PX * 4), dst);
    }
    cell.fill(0);
  };
  // Four splats: a main mass with a ring of drops thrown off it.
  for (let s = 0; s < 4; s++) {
    const rnd = lcg(900 + s * 31);
    blob(cell, 32, 32, 11 + rnd() * 5, rnd);
    for (let i = 0; i < 7; i++) streak(cell, 32, 32, rnd() * Math.PI * 2, 7, 11 + rnd() * 12, 0.7 + rnd() * 0.8, 165, 0, rnd);
    const n = 9 + Math.floor(rnd() * 8);
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.28;
      const d = 17 + rnd() * 13;
      blob(cell, 32 + Math.cos(a) * d, 32 + Math.sin(a) * d, 1.2 + rnd() * 3.2 * (1 - (d - 17) / 26), rnd);
    }
    put(s);
  }
  // A directional spray: a fat head at one end trailing off into a streak of drops (the long axis is x).
  {
    const rnd = lcg(77);
    blob(cell, 14, 32, 9, rnd, 1.5, 0);
    for (let i = 0; i < 22; i++) {
      const d = 12 + rnd() * 48;
      const spread = (rnd() - 0.5) * (4 + d * 0.28);
      blob(cell, 14 + d, 32 + spread, Math.max(0.9, (3.4 - d * 0.045) * (0.5 + rnd())), rnd, 1.4, 0);
    }
    put(4);
  }
  // A scatter of fine drops.
  {
    const rnd = lcg(55);
    for (let i = 0; i < 34; i++) {
      const a = rnd() * 6.28;
      const d = rnd() * 28;
      blob(cell, 32 + Math.cos(a) * d, 32 + Math.sin(a) * d, 0.9 + rnd() * 2.1, rnd);
    }
    put(5);
  }
  // Bullet holes: a clean one, a heavy splintered one, and a pit for earth and stone.
  holeCell(cell, 33, false);
  put(CELL.hole);
  holeCell(cell, 34, true);
  put(CELL.splinter);
  scuffCell(cell, 35);
  put(CELL.scuff);
  crackCell(cell, 36);
  put(CELL.crack);
  scarCell(cell, 37);
  put(CELL.scar);
  // A pool: one broad, smooth, slightly irregular puddle.
  {
    const rnd = lcg(21);
    blob(cell, 32, 32, 25, rnd);
    for (let i = 0; i < 5; i++) {
      const a = rnd() * 6.28;
      blob(cell, 32 + Math.cos(a) * 14, 32 + Math.sin(a) * 14, 8 + rnd() * 6, rnd);
    }
    put(7);
  }
  const tex = new THREE.DataTexture(out, W, H, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

let atlasTex: THREE.DataTexture | null = null;

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

export interface DecalOpts {
  /** Atlas cell. */
  cell: number;
  /** Width and height in metres. */
  w: number;
  h: number;
  /** Surface normal the mark lies on. */
  nx: number;
  ny: number;
  nz: number;
  /** Direction the long axis runs, projected onto the surface (x, y, z). Random when absent. */
  dx?: number;
  dy?: number;
  dz?: number;
  r?: number;
  g?: number;
  b?: number;
  opacity?: number;
  /** Holes stay as they are; blood dries. */
  hole?: boolean;
  /** Seconds to spread from a small puddle to full width. Zero keeps an immediate mark. */
  grow?: number;
}

export class Decals {
  readonly mesh: THREE.InstancedMesh;
  private param: Float32Array;
  private tint: Float32Array;
  /** Where each mark is, so marks on a wall that has come down can be taken off it. */
  private at: Float32Array;
  private paramAttr: THREE.InstancedBufferAttribute;
  private tintAttr: THREE.InstancedBufferAttribute;
  private next = 0;
  /** Marks placed since the last clear, capped at the pool size. */
  count = 0;
  /** Scene seconds, set by the scene each frame so blood can dry. */
  time = 0;
  private uniforms: Record<string, THREE.IUniform>;

  constructor(readonly capacity = 720) {
    atlasTex ??= atlas();
    const geo = new THREE.PlaneGeometry(1, 1);
    this.param = new Float32Array(capacity * 4);
    this.tint = new Float32Array(capacity * 3);
    this.at = new Float32Array(capacity * 3);
    this.paramAttr = new THREE.InstancedBufferAttribute(this.param, 4).setUsage(THREE.DynamicDrawUsage);
    this.tintAttr = new THREE.InstancedBufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aParam', this.paramAttr);
    geo.setAttribute('aTint', this.tintAttr);
    this.uniforms = {
      ...atmoUniforms(),
      tAtlas: { value: atlasTex },
      uLight: GLOBALS.uLight,
      uSceneTime: { value: 0 },
      uPullStep: DEPTH_UNIFORMS.uPullStep,
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    coplanarOffset(mat, COPLANAR.decal);
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  /** Put a mark on a surface. Returns its slot. */
  add(x: number, y: number, z: number, o: DecalOpts): number {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
    const z3 = _z.set(o.nx, o.ny, o.nz);
    if (z3.lengthSq() < 1e-8) z3.set(0, 1, 0);
    z3.normalize();
    // Long axis along the given direction flattened onto the surface, else a random one.
    const x3 = _x;
    if (o.dx !== undefined && o.dy !== undefined && o.dz !== undefined) x3.set(o.dx, o.dy, o.dz);
    else x3.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    x3.addScaledVector(z3, -x3.dot(z3));
    if (x3.lengthSq() < 1e-8) {
      x3.set(Math.abs(z3.y) < 0.9 ? 0 : 1, Math.abs(z3.y) < 0.9 ? 1 : 0, 0);
      x3.addScaledVector(z3, -x3.dot(z3));
    }
    x3.normalize();
    const y3 = _y.crossVectors(z3, x3);
    _m.makeBasis(x3.multiplyScalar(o.w), y3.multiplyScalar(o.h), z3);
    // Lifted off the surface a hair, on top of the depth bias, so it never sinks into curved ground.
    _m.setPosition(x + z3.x * 0.014, y + z3.y * 0.014, z + z3.z * 0.014);
    this.mesh.setMatrixAt(i, _m);
    this.at[i * 3] = x;
    this.at[i * 3 + 1] = y;
    this.at[i * 3 + 2] = z;
    this.param[i * 4] = o.cell;
    this.param[i * 4 + 1] = o.opacity ?? 0.85;
    this.param[i * 4 + 2] = this.time;
    const grow = o.grow ?? (o.cell === CELL.pool ? 3.5 : 0);
    this.param[i * 4 + 3] = o.hole ? 1 : -Math.max(0, grow);
    this.tint[i * 3] = o.r ?? 0.5;
    this.tint[i * 3 + 1] = o.g ?? 0.03;
    this.tint[i * 3 + 2] = o.b ?? 0.03;
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.paramAttr.needsUpdate = true;
    this.tintAttr.needsUpdate = true;
    return i;
  }

  /** Take off every mark whose centre lies in a box (the wall it was on has gone). Returns how many. */
  removeInBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const x = this.at[i * 3];
      const y = this.at[i * 3 + 1];
      const z = this.at[i * 3 + 2];
      if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1 || this.param[i * 4 + 1] === 0) continue;
      this.param[i * 4 + 1] = 0;
      _m.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, _m);
      n++;
    }
    if (n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.paramAttr.needsUpdate = true;
    }
    return n;
  }

  update(time: number) {
    this.time = time;
    this.uniforms.uSceneTime.value = time;
  }

  clear() {
    this.count = 0;
    this.next = 0;
    this.mesh.count = 0;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
