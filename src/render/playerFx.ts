import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp } from '../core/math';
import type { Look } from '../sim/drugs';
import type { GameRenderer } from './renderer';

/**
 * The part of a trip that lives in the world rather than on the lens, drawn into one player's view only. The two views
 * share one scene, so each player's effects are written into shared buffers just before that view draws and hidden just
 * after: the partner never sees the other's spores, mushrooms, auras or ghostly road.
 *
 *  - motes: spores, fireflies, smoke wisps and rainbow dust floating round you, and bursts when a phantom dissolves;
 *  - sense marks: glowing rings on the living and on loot, drawn through walls and hills, and the lit road ahead;
 *  - giant mushrooms that grow up out of the ground around you.
 */

export type MarkKind = 'zombie' | 'hunter' | 'animal' | 'raider' | 'loot' | 'chest' | 'path';

export interface Mark {
  x: number;
  y: number;
  z: number;
  kind: MarkKind;
  /** 0..1 how strong (fades toward the edge of sense range). */
  strength: number;
}

const MARK_COLOR: Record<MarkKind, [number, number, number]> = {
  zombie: [0.78, 0.42, 1.0],
  hunter: [1.0, 0.28, 0.2],
  animal: [0.4, 1.0, 0.5],
  raider: [1.0, 0.62, 0.2],
  loot: [1.0, 0.85, 0.35],
  chest: [0.4, 0.9, 1.0],
  path: [1.0, 0.92, 0.55],
};
const MARK_SIZE: Record<MarkKind, number> = { zombie: 1.5, hunter: 1.7, animal: 1.2, raider: 1.6, loot: 0.9, chest: 1.2, path: 0.7 };

const N_AMB = 180;
const N_BURST = 48;
const N_MOTE = N_AMB + N_BURST;
const N_MARK = 140;
const N_MUSH = 56;
const MOTE_R = 17;
const CELL = 8;

// ------------------------------------------------------------------------------------------------ shaders

const POINT_VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
varying vec4 vColor;
uniform float uScale;
uniform vec2 uClampPx;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp( aSize * uScale / max( 0.1, - mv.z ), uClampPx.x, uClampPx.y );
}`;

const MOTE_FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length( c ) * 2.0;
  float a = smoothstep( 1.0, 0.0, r );
  a *= a;
  if ( a * vColor.a < 0.003 ) discard;
  gl_FragColor = vec4( vColor.rgb, a * vColor.a );
}`;

/** A ring with a soft core: reads as an aura round a body, and as a beacon at a distance. */
const MARK_FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length( c ) * 2.0;
  float ring = smoothstep( 0.95, 0.78, r ) * smoothstep( 0.4, 0.66, r );
  float core = smoothstep( 0.4, 0.0, r ) * 0.55;
  float a = ( ring + core ) * vColor.a;
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( vColor.rgb * ( 1.0 + ring ), a );
}`;

// ------------------------------------------------------------------------------------------------ helpers

const hash = (x: number, z: number, s = 0) => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(s | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function pointsMaterial(frag: string, depthTest: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 800 }, uClampPx: { value: new THREE.Vector2(2, 80) } },
    vertexShader: POINT_VERT,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    depthTest,
    fog: false,
    blending: THREE.AdditiveBlending,
  });
}

interface PointBuf {
  points: THREE.Points;
  pos: Float32Array;
  col: Float32Array;
  size: Float32Array;
  mat: THREE.ShaderMaterial;
}

function pointBuf(n: number, frag: string, depthTest: boolean, order: number): PointBuf {
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 4);
  const size = new Float32Array(n);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = pointsMaterial(frag, depthTest);
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = order;
  points.visible = false;
  return { points, pos, col, size, mat };
}

function flush(b: PointBuf, n: number) {
  const g = b.points.geometry;
  g.setDrawRange(0, n);
  (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  (g.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
  (g.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
}

/** Cosine palette, the same as the shaders use. */
function rainbow(h: number, out: [number, number, number]) {
  out[0] = 0.5 + 0.5 * Math.cos(6.2831853 * (h + 0));
  out[1] = 0.5 + 0.5 * Math.cos(6.2831853 * (h + 0.33));
  out[2] = 0.5 + 0.5 * Math.cos(6.2831853 * (h + 0.67));
}

// ------------------------------------------------------------------------------------------------ mushrooms

interface Shroom {
  x: number;
  y: number;
  z: number;
  /** Height of the whole thing in metres. */
  h: number;
  /** The `mush` level at which it starts to grow. */
  at: number;
  phase: number;
  hue: number;
  yaw: number;
}

function shroomGeometry(): THREE.BufferGeometry {
  const stem = new THREE.CylinderGeometry(0.1, 0.17, 1, 8, 1).translate(0, 0.5, 0);
  const cap = new THREE.SphereGeometry(0.62, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.62, 1).translate(0, 0.96, 0);
  const rim = new THREE.TorusGeometry(0.58, 0.06, 5, 16).rotateX(Math.PI / 2).translate(0, 0.96, 0);
  const paint = (g: THREE.BufferGeometry, v: number) => {
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3).fill(v);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  };
  return mergeGeometries([paint(stem, 0.5), paint(cap, 1), paint(rim, 0.8)], false);
}

// ------------------------------------------------------------------------------------------------ the thing

interface PlayerState {
  mp: Float32Array;
  mv: Float32Array;
  mseed: Float32Array;
  malpha: Float32Array;
  mlife: Float32Array;
  mmax: Float32Array;
  mcol: Float32Array;
  shrooms: Shroom[];
  shroomKey: string;
  shroomAt: number;
  marks: Mark[];
  look: Look | null;
  t: number;
  /** Where the player is, for placing the ambient motes. */
  cx: number;
  cy: number;
  cz: number;
  burstNext: number;
  ready: boolean;
  /** Anything to draw at all this frame? Lets a sober player skip the whole write-out. */
  active: boolean;
  /** Some mote is still visible (fading out, or a burst in flight). */
  anyMote: boolean;
}

export class PlayerFx {
  readonly group = new THREE.Group();
  private motes: PointBuf;
  private marksBuf: PointBuf;
  private mush: THREE.InstancedMesh;
  private mushMat: THREE.MeshStandardMaterial;
  private st: [PlayerState, PlayerState];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private pv = new THREE.Vector3();
  private sv = new THREE.Vector3();
  private col = new THREE.Color();
  private tmp: [number, number, number] = [0, 0, 0];

  constructor(private R: GameRenderer) {
    this.motes = pointBuf(N_MOTE, MOTE_FRAG, true, 7);
    this.marksBuf = pointBuf(N_MARK, MARK_FRAG, false, 9);
    this.mushMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 });
    this.mushMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.85;');
    };
    this.mushMat.customProgramCacheKey = () => 'shroom';
    this.mush = new THREE.InstancedMesh(shroomGeometry(), this.mushMat, N_MUSH);
    this.mush.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mush.frustumCulled = false;
    this.mush.castShadow = false;
    this.mush.receiveShadow = false;
    this.mush.count = 0;
    this.mush.visible = false;
    // Give every instance a colour slot up front.
    this.mush.setColorAt(0, this.col.setRGB(1, 1, 1));
    this.group.add(this.motes.points, this.marksBuf.points, this.mush);
    const mk = (): PlayerState => ({
      mp: new Float32Array(N_MOTE * 3),
      mv: new Float32Array(N_MOTE * 3),
      mseed: Float32Array.from({ length: N_MOTE }, () => Math.random()),
      malpha: new Float32Array(N_MOTE),
      mlife: new Float32Array(N_MOTE),
      mmax: new Float32Array(N_MOTE).fill(1),
      mcol: new Float32Array(N_MOTE * 3),
      shrooms: [],
      shroomKey: '',
      shroomAt: 0,
      marks: [],
      look: null,
      t: 0,
      cx: 0,
      cy: 0,
      cz: 0,
      burstNext: N_AMB,
      ready: false,
      active: false,
      anyMote: false,
    });
    this.st = [mk(), mk()];
  }

  // ------------------------------------------------------------------ per frame

  /**
   * Advance one player's effects. `groundAt` places things on the ground, `blocked` keeps mushrooms off roads and water,
   * `marks` is what their sense shows right now.
   */
  update(i: number, dt: number, look: Look, phase: number, at: { x: number; y: number; z: number }, groundAt: (x: number, z: number) => number, blocked: (x: number, z: number) => boolean, marks: Mark[]) {
    const s = this.st[i];
    s.look = look;
    s.t = phase;
    s.cx = at.x;
    s.cy = at.y;
    s.cz = at.z;
    s.marks = marks;
    this.stepMotes(s, dt, look, groundAt);
    this.stepShrooms(s, look, groundAt, blocked);
    s.active = marks.length > 0 || s.shrooms.length > 0 || s.anyMote;
  }

  /** Dissolving phantoms and the like: a little burst of colour at a point. */
  burst(i: number, x: number, y: number, z: number, seed: number) {
    const s = this.st[i];
    for (let k = 0; k < 16; k++) {
      const n = s.burstNext;
      s.burstNext = s.burstNext + 1 >= N_MOTE ? N_AMB : s.burstNext + 1;
      const a = Math.random() * Math.PI * 2;
      const e = (Math.random() - 0.3) * 1.2;
      const sp = 1.5 + Math.random() * 3.5;
      s.mp[n * 3] = x;
      s.mp[n * 3 + 1] = y;
      s.mp[n * 3 + 2] = z;
      s.mv[n * 3] = Math.cos(a) * sp;
      s.mv[n * 3 + 1] = e * sp;
      s.mv[n * 3 + 2] = Math.sin(a) * sp;
      s.mlife[n] = s.mmax[n] = 0.9 + Math.random() * 0.6;
      s.mseed[n] = (seed + Math.random() * 0.2) % 1;
    }
  }

  private stepMotes(s: PlayerState, dt: number, look: Look, groundAt: (x: number, z: number) => number) {
    const want = Math.floor(N_AMB * clamp(look.spores, 0, 1));
    const t = s.t;
    let any = false;
    const hueAmt = clamp(look.hue * 1.5, 0, 1);
    for (let n = 0; n < N_MOTE; n++) {
      const o = n * 3;
      const seed = s.mseed[n];
      if (n < N_AMB) {
        const on = n < want;
        s.malpha[n] = lerp(s.malpha[n], on ? 0.35 + 0.5 * seed : 0, 1 - Math.exp(-dt * 2.5));
        if (s.malpha[n] < 0.004 && !on) continue;
        // Drift: a slow swirl with a lift, never quite the same twice.
        const k = 0.5 + seed;
        s.mp[o] += Math.sin(t * 0.55 * k + seed * 40) * 0.45 * dt;
        s.mp[o + 1] += (0.18 + 0.2 * Math.sin(t * 0.8 + seed * 9)) * dt;
        s.mp[o + 2] += Math.cos(t * 0.48 * k + seed * 31) * 0.45 * dt;
        const dx = s.mp[o] - s.cx;
        const dz = s.mp[o + 2] - s.cz;
        const g = groundAt(s.mp[o], s.mp[o + 2]);
        const tooFar = dx * dx + dz * dz > MOTE_R * MOTE_R || s.mp[o + 1] > g + 9 || !s.ready;
        if (tooFar) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * (MOTE_R - 1);
          s.mp[o] = s.cx + Math.cos(a) * r;
          s.mp[o + 2] = s.cz + Math.sin(a) * r;
          s.mp[o + 1] = groundAt(s.mp[o], s.mp[o + 2]) + 0.3 + Math.random() * 6;
        }
        const h = (seed + t * 0.06) % 1;
        rainbow(h, this.tmp);
        // Low hue is smoke: pale and green. High hue is a rainbow.
        s.mcol[o] = lerp(0.72, this.tmp[0], hueAmt) * (1 + look.tintR);
        s.mcol[o + 1] = lerp(0.9, this.tmp[1], hueAmt) * (1 + look.tintG);
        s.mcol[o + 2] = lerp(0.72, this.tmp[2], hueAmt) * (1 + look.tintB);
      } else {
        // Burst motes live and die.
        if (s.mlife[n] > 0) {
          s.mlife[n] -= dt;
          const k = Math.exp(-2.2 * dt);
          s.mv[o] *= k;
          s.mv[o + 1] = s.mv[o + 1] * k + 0.4 * dt;
          s.mv[o + 2] *= k;
          s.mp[o] += s.mv[o] * dt;
          s.mp[o + 1] += s.mv[o + 1] * dt;
          s.mp[o + 2] += s.mv[o + 2] * dt;
          s.malpha[n] = clamp(s.mlife[n] / s.mmax[n], 0, 1);
          rainbow(seed, this.tmp);
          s.mcol[o] = this.tmp[0];
          s.mcol[o + 1] = this.tmp[1];
          s.mcol[o + 2] = this.tmp[2];
        } else s.malpha[n] = 0;
      }
      if (s.malpha[n] >= 0.004) any = true;
    }
    s.anyMote = any;
    s.ready = true;
  }

  private stepShrooms(s: PlayerState, look: Look, groundAt: (x: number, z: number) => number, blocked: (x: number, z: number) => boolean) {
    if (look.mush < 0.02) {
      s.shrooms.length = 0;
      s.shroomKey = '';
      return;
    }
    const cx = Math.floor(s.cx / CELL);
    const cz = Math.floor(s.cz / CELL);
    const key = `${cx},${cz}`;
    if (key === s.shroomKey) return;
    s.shroomKey = key;
    const out: Shroom[] = [];
    const R = 4;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const gx = cx + dx;
        const gz = cz + dz;
        if (hash(gx, gz, 1) > 0.4) continue;
        const x = (gx + 0.15 + hash(gx, gz, 2) * 0.7) * CELL;
        const z = (gz + 0.15 + hash(gx, gz, 3) * 0.7) * CELL;
        if (Math.hypot(x - s.cx, z - s.cz) < 3.4 || blocked(x, z)) continue;
        out.push({ x, y: groundAt(x, z), z, h: 1.2 + hash(gx, gz, 4) * 3.4, at: hash(gx, gz, 5) * 0.7, phase: hash(gx, gz, 6) * 6.28, hue: hash(gx, gz, 7), yaw: hash(gx, gz, 8) * 6.28 });
      }
    }
    out.sort((a, b) => (a.x - s.cx) ** 2 + (a.z - s.cz) ** 2 - ((b.x - s.cx) ** 2 + (b.z - s.cz) ** 2));
    s.shrooms = out.slice(0, N_MUSH);
  }

  // ------------------------------------------------------------------ per view

  /** Write one player's effects into the buffers and show them, just before their view draws. */
  beginView(i: number, cam: THREE.PerspectiveCamera) {
    const s = this.st[i];
    const look = s.look;
    if (!look || !s.active) return;
    const scale = (this.R.views[i].rect.h * this.R.renderPixelRatio()) / (2 * Math.tan((cam.fov * Math.PI) / 360));
    // Motes.
    {
      const b = this.motes;
      let n = 0;
      for (let k = 0; k < N_MOTE; k++) {
        const a = s.malpha[k];
        if (a < 0.004) continue;
        b.pos[n * 3] = s.mp[k * 3];
        b.pos[n * 3 + 1] = s.mp[k * 3 + 1];
        b.pos[n * 3 + 2] = s.mp[k * 3 + 2];
        b.col[n * 4] = s.mcol[k * 3];
        b.col[n * 4 + 1] = s.mcol[k * 3 + 1];
        b.col[n * 4 + 2] = s.mcol[k * 3 + 2];
        b.col[n * 4 + 3] = a;
        b.size[n] = k < N_AMB ? 0.1 + 0.16 * s.mseed[k] : 0.28;
        n++;
      }
      b.mat.uniforms.uScale.value = scale;
      b.mat.uniforms.uClampPx.value.set(1.5, 40);
      flush(b, n);
      b.points.visible = n > 0;
    }
    // Sense marks: the living and the loot, pulsing with a heartbeat.
    {
      const b = this.marksBuf;
      let n = 0;
      const beat = 0.7 + 0.3 * Math.pow(Math.max(0, Math.sin(s.t * 5.4)), 4);
      for (const m of s.marks) {
        if (n >= N_MARK) break;
        const c = MARK_COLOR[m.kind];
        let a = m.strength * beat;
        let size = MARK_SIZE[m.kind];
        if (m.kind === 'path') {
          // A pulse travelling up the road ahead, like something swimming along it.
          const wave = 0.5 + 0.5 * Math.sin(m.z * 0.22 - s.t * 3.2);
          a *= 0.3 + 0.7 * wave;
          size *= 0.7 + 0.5 * wave;
        }
        b.pos[n * 3] = m.x;
        b.pos[n * 3 + 1] = m.y;
        b.pos[n * 3 + 2] = m.z;
        b.col[n * 4] = c[0];
        b.col[n * 4 + 1] = c[1];
        b.col[n * 4 + 2] = c[2];
        b.col[n * 4 + 3] = clamp(a, 0, 1);
        b.size[n] = size;
        n++;
      }
      b.mat.uniforms.uScale.value = scale;
      b.mat.uniforms.uClampPx.value.set(8, 90);
      flush(b, n);
      b.points.visible = n > 0;
    }
    // Mushrooms.
    {
      let n = 0;
      for (const sh of s.shrooms) {
        if (n >= N_MUSH) break;
        const grow = smooth(sh.at, sh.at + 0.3, look.mush);
        if (grow < 0.01) continue;
        // Pop up with a little overshoot, then breathe with the heartbeat.
        const over = 1 + 0.12 * Math.sin(Math.min(1, grow) * Math.PI);
        const breathe = 1 + 0.06 * Math.sin(s.t * 3 + sh.phase) + look.pulse * 0.05 * Math.pow(Math.max(0, Math.sin(s.t * 5.4 + sh.phase * 0.1)), 4);
        const h = sh.h * grow * over * breathe;
        this.e.set(0, sh.yaw, 0);
        this.q.setFromEuler(this.e);
        this.pv.set(sh.x, sh.y - 0.05, sh.z);
        this.sv.set(h * 0.55, h, h * 0.55);
        this.m.compose(this.pv, this.q, this.sv);
        this.mush.setMatrixAt(n, this.m);
        rainbow((sh.hue * 0.5 + 0.55 + s.t * 0.01) % 1, this.tmp);
        this.col.setRGB(0.35 + this.tmp[0] * 0.75, 0.3 + this.tmp[1] * 0.7, 0.45 + this.tmp[2] * 0.7);
        this.mush.setColorAt(n, this.col);
        n++;
      }
      this.mush.count = n;
      this.mush.instanceMatrix.needsUpdate = true;
      if (this.mush.instanceColor) this.mush.instanceColor.needsUpdate = true;
      this.mush.visible = n > 0;
    }
  }

  endView() {
    this.motes.points.visible = false;
    this.marksBuf.points.visible = false;
    this.mush.visible = false;
  }

  dispose() {
    for (const b of [this.motes, this.marksBuf]) {
      b.points.geometry.dispose();
      b.mat.dispose();
    }
    this.mush.geometry.dispose();
    this.mush.dispose();
    this.mushMat.dispose();
    this.group.removeFromParent();
  }
}
