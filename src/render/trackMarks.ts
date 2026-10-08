import * as THREE from 'three';
import { COPLANAR, DEPTH_UNIFORMS, PULL, coplanarOffset, depthPullGlsl } from './depth';
import type { MarkStyle } from '../sim/bodywork';

/**
 * Tyre tracks. Every wheel in contact with the ground lays a ribbon behind it: in sand, hard earth and mud a groove with
 * raised edges and a printed tread, on asphalt a black rubber skid where the tyre is being scrubbed. All of it lives in one
 * ring buffer drawn as one mesh, so the cost is the same whether there is one track or six thousand segments: when the
 * buffer fills, the oldest marks are overwritten. Marks fade slowly with age and dissolve with distance from the camera.
 *
 * A mark is not terrain deformation: it is a lit decal a couple of centimetres off the ground, with a cross-section profile
 * (berm, wall, floor) that gives it normals, so the sun catches the edge of a groove.
 */

/** Segments in the ring buffer. */
const SEGMENTS = 7000;
/** Vertices across the ribbon, and per segment (two edges). */
const ACROSS = 5;
const PER_SEG = ACROSS * 2;
/** A new segment is laid once the wheel has moved this far, metres. */
const STEP = 0.42;
/** Sideways positions as multiples of the half width (left positive), the profile height (in units of groove depth) and opacity. */
const AX = [1.14, 0.98, 0, -0.98, -1.14];
const GROOVE_H = [0, 0.35, -0.6, 0.35, 0];
const GROOVE_A = [0, 0.5, 1, 0.5, 0];
const SKID_A = [0, 0.95, 1, 0.95, 0];
/**
 * Height of the groove's floor above the surface it is laid on. The caller gives the surface as drawn (the terrain mesh, or
 * the road the tyre is on), so the floor lies right where the tyre touches and the berms stand up either side of it.
 */
const LIFT = 0.008;

export interface TrackSnapshot {
  pos: Float32Array;
  nor: Float32Array;
  col: Float32Array;
  mark: Float32Array;
  head: number;
  laid: number;
  time: number;
}

const KIND_GROOVE = 0;
const KIND_SKID = 1;
const KIND_MUD = 2;

interface Trail {
  x: number;
  z: number;
  kind: number;
  /** Distance laid so far along this ribbon, so the tread print runs on unbroken from one segment to the next. */
  v: number;
  /** The last end edge written, so the next segment starts exactly where this one stopped. */
  edge: Float32Array | null;
  next: Float32Array | null;
}

const VERT_PARS = `attribute vec4 aMark;\nuniform float uPullStep;\nvarying vec4 vMark;\nvarying vec3 vMarkW;\n#include <common>`;
// Pulled toward the eye above every road layer (see depth.ts), so the tracks stay on the road far off.
const VERT_MAIN = `vMark = aMark;\nvMarkW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n#include <project_vertex>\n${depthPullGlsl(PULL.mark.toFixed(1))}`;
const FRAG_PARS = `varying vec4 vMark;\nvarying vec3 vMarkW;\nuniform sampler2D tMark;\nuniform float uMarkTime;\n#include <common>`;
const FRAG_COLOR = /* glsl */ `
#include <color_fragment>
{
  vec2 tex = texture2D( tMark, vec2( vMark.x, vMark.y ) ).rg;
  float isSkid = step( 0.5, vMark.w ) * step( vMark.w, 1.5 );
  float life = vMark.w > 1.5 ? 3.0 : ( isSkid > 0.5 ? 1.6 : 1.0 );
  float age = uMarkTime - vMark.z;
  float fade = 1.0 - smoothstep( 200.0 * life, 620.0 * life, age );
  float near = 1.0 - smoothstep( 85.0, 160.0, distance( vMarkW, cameraPosition ) );
  diffuseColor.a *= mix( tex.r, tex.g, isSkid ) * fade * near;
  if ( diffuseColor.a < 0.01 ) discard;
}`;

let markTex: THREE.DataTexture | null = null;

/** r: a herringbone tread print, g: the streaky grain of a skid. Both tile along the ribbon (v). */
function markTexture(): THREE.DataTexture {
  if (markTex) return markTex;
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / (S - 1);
      // Chevrons: bars slanting in from each edge to a seam down the middle.
      const cu = Math.abs(u - 0.5) * 2;
      const phase = (y / S) * 2 + cu * 0.9;
      const bar = Math.abs((((phase % 1) + 1) % 1) - 0.5) * 2;
      const tread = 0.16 + 0.84 * Math.max(0, Math.min(1, (bar - 0.3) * 7));
      const edge = Math.min(1, (1 - cu) * 5);
      const h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) >>> 0;
      const r = (h ^ (h >>> 13)) / 4294967296;
      const streak = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(x * 2.1 + r * 3)) * (0.7 + 0.3 * r);
      const i = (y * S + x) * 4;
      // A floor that is mostly covered, with the tread blocks pressed deeper (darker) into it.
      data[i] = Math.round(255 * (0.55 + 0.45 * tread) * (0.9 + 0.1 * r) * Math.min(1, 0.5 + edge));
      data[i + 1] = Math.round(255 * Math.min(1, streak));
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  t.userData.shared = true;
  markTex = t;
  return t;
}

export class TrackMarks {
  readonly mesh: THREE.Mesh;
  private pos = new Float32Array(SEGMENTS * PER_SEG * 3);
  private nor = new Float32Array(SEGMENTS * PER_SEG * 3);
  private col = new Float32Array(SEGMENTS * PER_SEG * 4);
  private mark = new Float32Array(SEGMENTS * PER_SEG * 4);
  private geo = new THREE.BufferGeometry();
  private trails = new Map<number, Trail>();
  private head = 0;
  private dirtyStart = 0;
  private dirtyCount = 0;
  private time = 0;
  private uTime = { value: 0 };
  /** Segments laid since the scene began, wrapping or not. */
  laid = 0;
  /** Distance of the camera beyond which the mark is not worth laying, so far-off traffic costs nothing. */
  constructor() {
    const g = this.geo;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4));
    g.setAttribute('aMark', new THREE.BufferAttribute(this.mark, 4));
    const idx = new Uint32Array(SEGMENTS * 24);
    for (let s = 0; s < SEGMENTS; s++) {
      const b = s * PER_SEG;
      for (let q = 0; q < ACROSS - 1; q++) {
        const a = b + q;
        const bb = b + q + 1;
        const c = b + ACROSS + q;
        const d = b + ACROSS + q + 1;
        const o = s * 24 + q * 6;
        idx[o] = a;
        idx[o + 1] = bb;
        idx[o + 2] = c;
        idx[o + 3] = bb;
        idx[o + 4] = d;
        idx[o + 5] = c;
      }
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const m = coplanarOffset(new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, depthWrite: false, roughness: 0.92, metalness: 0 }), COPLANAR.mark);
    const tex = markTexture();
    m.onBeforeCompile = (shader) => {
      shader.uniforms.tMark = { value: tex };
      shader.uniforms.uMarkTime = this.uTime;
      shader.uniforms.uPullStep = DEPTH_UNIFORMS.uPullStep;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', VERT_PARS).replace('#include <project_vertex>', VERT_MAIN);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', FRAG_PARS).replace('#include <color_fragment>', FRAG_COLOR);
    };
    m.customProgramCacheKey = () => 'trackmarks';
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;
  }

  /** Segments currently in the buffer. */
  get count(): number {
    return Math.min(this.laid, SEGMENTS);
  }

  /** The wheel left the ground (or stopped marking): the next contact starts a new ribbon. */
  lift(key: number) {
    this.trails.delete(key);
  }

  /**
   * One wheel is on the ground at (x, z). Once it has moved a step from where it last marked, a segment joins the
   * ribbon. `ground` gives the height of the drawn surface under each corner; `halfW` is half the tyre's width.
   */
  lay(key: number, x: number, z: number, halfW: number, style: MarkStyle, ground: (x: number, z: number) => number) {
    const kind = style.kind === 'skid' ? KIND_SKID : style.depth > 0.03 ? KIND_MUD : KIND_GROOVE;
    const t = this.trails.get(key);
    if (!t || t.kind !== kind) {
      this.trails.set(key, { x, z, kind, v: 0, edge: null, next: null });
      return;
    }
    const dx = x - t.x;
    const dz = z - t.z;
    const dist = Math.hypot(dx, dz);
    if (dist < STEP) return;
    if (dist > 7) {
      // Teleported (a respawn, a flip recovery): start again.
      t.x = x;
      t.z = z;
      t.edge = null;
      return;
    }
    const nx = dx / dist;
    const nz = dz / dist;
    const seg = this.head;
    this.head = (this.head + 1) % SEGMENTS;
    this.laid++;
    if (!this.dirtyCount) this.dirtyStart = seg;
    this.dirtyCount = Math.min(SEGMENTS, this.dirtyCount + 1);
    const v0 = seg * PER_SEG;
    const lx = nz;
    const lz = -nx;
    const hw = halfW * (style.kind === 'skid' ? 0.85 : 1);
    const prof = style.kind === 'skid' ? SKID_A : GROOVE_A;
    const depth = style.kind === 'skid' ? 0 : style.depth;
    // Start edge: the previous end edge if there is one, else the same ribbon laid out along this direction.
    const start = t.edge ?? this.edge(t.x, t.z, lx, lz, hw, depth, ground);
    const end = this.edge(x, z, lx, lz, hw, depth, ground, t.next);
    const age = this.time;
    const u = [0, 0.25, 0.5, 0.75, 1];
    const vA = t.v;
    const vB = vA + dist;
    t.v = vB;
    for (let q = 0; q < ACROSS; q++) {
      // The raised edges of a groove are lighter than its floor.
      const tone = style.kind === 'skid' || q === 2 ? style.tone : style.berm;
      this.vertex(v0 + q, start, q, prof[q], tone, style.alpha, u[q], vA * 1.6, age, kind);
      this.vertex(v0 + ACROSS + q, end, q, prof[q], tone, style.alpha, u[q], vB * 1.6, age, kind);
    }
    // Normals follow the profile's slope across the ribbon.
    this.normals(v0, lx, lz, hw, depth, style.kind === 'skid');
    t.x = x;
    t.z = z;
    t.edge = end;
    t.next = start;
  }

  private edge(cx: number, cz: number, lx: number, lz: number, hw: number, depth: number, ground: (x: number, z: number) => number, target: Float32Array | null = null): Float32Array {
    const e = target ?? new Float32Array(ACROSS * 3);
    for (let q = 0; q < ACROSS; q++) {
      const px = cx + lx * AX[q] * hw;
      const pz = cz + lz * AX[q] * hw;
      e[q * 3] = px;
      e[q * 3 + 1] = ground(px, pz) + LIFT + (GROOVE_H[q] - GROOVE_H[2]) * depth;
      e[q * 3 + 2] = pz;
    }
    return e;
  }

  private vertex(i: number, edge: Float32Array, q: number, a: number, tone: readonly number[], alpha: number, u: number, v: number, birth: number, kind: number) {
    this.pos[i * 3] = edge[q * 3];
    this.pos[i * 3 + 1] = edge[q * 3 + 1];
    this.pos[i * 3 + 2] = edge[q * 3 + 2];
    this.col[i * 4] = tone[0];
    this.col[i * 4 + 1] = tone[1];
    this.col[i * 4 + 2] = tone[2];
    this.col[i * 4 + 3] = alpha * a;
    this.mark[i * 4] = u;
    this.mark[i * 4 + 1] = v;
    this.mark[i * 4 + 2] = birth;
    this.mark[i * 4 + 3] = kind;
  }

  private normals(v0: number, lx: number, lz: number, hw: number, depth: number, flat: boolean) {
    for (let side = 0; side < 2; side++) {
      for (let q = 0; q < ACROSS; q++) {
        let slope = 0;
        if (!flat && depth > 0) {
          const q0 = Math.max(0, q - 1);
          const q1 = Math.min(ACROSS - 1, q + 1);
          slope = ((GROOVE_H[q1] - GROOVE_H[q0]) * depth) / ((AX[q1] - AX[q0]) * hw);
        }
        // Height rises with the left coordinate at `slope`, so the surface leans against it.
        let nx = -slope * lx;
        const ny = 1;
        let nz = -slope * lz;
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        nz /= l;
        const i = (v0 + side * ACROSS + q) * 3;
        this.nor[i] = nx;
        this.nor[i + 1] = ny / l;
        this.nor[i + 2] = nz;
      }
    }
  }

  /** Once per rendered frame: the clock the marks fade by, and whichever part of the buffers changed. */
  update(dt: number) {
    this.time += dt;
    this.uTime.value = this.time;
    if (!this.dirtyCount) return;
    const a = this.geo.attributes;
    const first = this.dirtyStart * PER_SEG;
    const n = Math.min(this.dirtyCount, SEGMENTS - this.dirtyStart) * PER_SEG;
    const wrapped = this.dirtyCount * PER_SEG - n;
    for (const [attr, size] of [
      [a.position, 3],
      [a.normal, 3],
      [a.color, 4],
      [a.aMark, 4],
    ] as const) {
      const at = attr as THREE.BufferAttribute;
      at.addUpdateRange(first * size, n * size);
      if (wrapped) at.addUpdateRange(0, wrapped * size);
      at.needsUpdate = true;
    }
    this.geo.setDrawRange(0, this.laid >= SEGMENTS ? SEGMENTS * 24 : this.head * 24);
    this.dirtyCount = 0;
  }

  /** The clock marks are stamped with, for tests. */
  get clock() {
    return this.time;
  }

  /** Everything laid so far, copied out: the open world keeps it from one day's scene to the next. */
  snapshot(): TrackSnapshot {
    return { pos: this.pos.slice(), nor: this.nor.slice(), col: this.col.slice(), mark: this.mark.slice(), head: this.head, laid: this.laid, time: this.time };
  }

  /** Lay a snapshot back down. Marks keep their age: the clock carries on from where it stopped. */
  restore(s: TrackSnapshot) {
    this.pos.set(s.pos);
    this.nor.set(s.nor);
    this.col.set(s.col);
    this.mark.set(s.mark);
    this.head = s.head;
    this.laid = s.laid;
    this.time = s.time;
    this.uTime.value = s.time;
    this.trails.clear();
    this.dirtyStart = 0;
    this.dirtyCount = SEGMENTS;
  }

  clear() {
    this.trails.clear();
    this.head = 0;
    this.laid = 0;
    this.dirtyCount = 0;
    this.pos.fill(0);
    this.geo.setDrawRange(0, 0);
  }

  dispose() {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
