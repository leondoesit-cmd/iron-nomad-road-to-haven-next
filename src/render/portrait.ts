import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { shared } from './dispose';
import { applyKit } from './materials';
import { clamp01, lerp, smoothstep } from '../core/math';
import { valueNoise3 } from '../core/noise';
import { DEG, GRID_U, GRID_V, RAY_Z, beardCover, hairlineAt, paintTexels, phiAt, rayY, thetaAt, type HeadShape, type PortraitSpec, type V3 } from './portraitPaint';
import type { PaintJob } from './portraitPaint.worker';

export type { FacePaint, FacialHair, HairSpec, HeadShape, PortraitSpec, V2, V3 } from './portraitPaint';
export { FacePainter, GRID_U, GRID_V, azimuthOf, beardCover, hairlineAt, phiAt, scalpCover, thetaAt } from './portraitPaint';

/**
 * Portrait heads: the likeness of a real person, sculpted as a signed distance field and painted in code.
 *
 * The skull, face, beard volume and neck are one distance field. Rays cast out from a line inside the head find its
 * surface on a grid that is dense across the face and sparse at the back; the grid gives the mesh its UVs (azimuth and
 * elevation of the ray), so the texture is painted per texel from the 3D point it lands on (`portraitPaint.ts`). Hair is a
 * second shell grown off the same grid, so it shares the UVs and the strands painted under it. Ears are separate,
 * vertex-coloured solids.
 */

/** 'full' hair, or 'covered' when something is worn on the head and the hair has to fit under it. */
export type HairMode = 'full' | 'covered';

// ------------------------------------------------------------------------------------------ distance field

interface Op {
  sub: boolean;
  ell: boolean;
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  ra: number;
  rb: number;
  k: number;
  ox: number;
  oy: number;
  oz: number;
  or: number;
}

function smin(a: number, b: number, k: number) {
  const m = a < b ? a : b;
  if (k <= 0) return m;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return m - h * h * k * 0.25;
}

function ellDist(o: Op, x: number, y: number, z: number) {
  const px = (x - o.ax) / o.bx;
  const py = (y - o.ay) / o.by;
  const pz = (z - o.az) / o.bz;
  const k0 = Math.sqrt(px * px + py * py + pz * pz);
  const qx = px / o.bx;
  const qy = py / o.by;
  const qz = pz / o.bz;
  const k1 = Math.sqrt(qx * qx + qy * qy + qz * qz);
  return k1 < 1e-9 ? -Math.min(o.bx, o.by, o.bz) : (k0 * (k0 - 1)) / k1;
}

function capDist(o: Op, x: number, y: number, z: number) {
  const pax = x - o.ax;
  const pay = y - o.ay;
  const paz = z - o.az;
  const bax = o.bx - o.ax;
  const bay = o.by - o.ay;
  const baz = o.bz - o.az;
  const bb = bax * bax + bay * bay + baz * baz;
  const h = bb > 0 ? clamp01((pax * bax + pay * bay + paz * baz) / bb) : 0;
  const qx = pax - bax * h;
  const qy = pay - bay * h;
  const qz = paz - baz * h;
  return Math.sqrt(qx * qx + qy * qy + qz * qz) - (o.ra + (o.rb - o.ra) * h);
}

/** A head as a signed distance field: smooth unions and cuts of ellipsoids and tapered capsules. */
export class HeadField {
  readonly ops: Op[] = [];
  /** Outward growth on top of the shapes, by position: a beard's thickness. */
  grow: ((x: number, y: number, z: number) => number) | null = null;
  /** The head stops flat at this height, down inside the collar. */
  floor = -0.068;

  ell(c: V3, r: V3, k: number, sub = false) {
    this.ops.push({ sub, ell: true, ax: c[0], ay: c[1], az: c[2], bx: r[0], by: r[1], bz: r[2], ra: 0, rb: 0, k, ox: c[0], oy: c[1], oz: c[2], or: Math.max(r[0], r[1], r[2]) });
    return this;
  }

  /** The same ellipsoid on both sides of the face, at +x and -x. */
  pair(c: V3, r: V3, k: number, sub = false) {
    this.ell([c[0], c[1], c[2]], r, k, sub);
    return this.ell([-c[0], c[1], c[2]], r, k, sub);
  }

  cap(a: V3, b: V3, ra: number, rb: number, k: number, sub = false) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    this.ops.push({ sub, ell: false, ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], ra, rb, k, ox: (a[0] + b[0]) / 2, oy: (a[1] + b[1]) / 2, oz: (a[2] + b[2]) / 2, or: len / 2 + Math.max(ra, rb) });
    return this;
  }

  capPair(a: V3, b: V3, ra: number, rb: number, k: number, sub = false) {
    this.cap(a, b, ra, rb, k, sub);
    return this.cap([-a[0], a[1], a[2]], [-b[0], b[1], b[2]], ra, rb, k, sub);
  }

  at(x: number, y: number, z: number): number {
    let d = 1;
    const ops = this.ops;
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      const dx = x - o.ox;
      const dy = y - o.oy;
      const dz = z - o.oz;
      // Skip shapes too far away to change the answer: a cut that cannot reach, or a union that cannot come closer.
      const lb = Math.sqrt(dx * dx + dy * dy + dz * dz) - o.or;
      if (o.sub ? lb >= o.k - d : lb >= d + o.k) continue;
      const s = o.ell ? ellDist(o, x, y, z) : capDist(o, x, y, z);
      d = o.sub ? -smin(-d, s, o.k) : smin(d, s, o.k);
    }
    if (this.grow) d -= this.grow(x, y, z);
    const f = this.floor - y;
    return d > f ? d : f;
  }
}

/** The head as shapes: skull, brow, eyes, cheeks, nose, lips, jaw, chin and neck. */
export function headField(s: HeadShape): HeadField {
  const f = new HeadField();
  const E = s.eyeY;
  const Z = s.eyeZ;
  const X = s.eyeX;
  const n = s.nose;
  const m = s.mouth;
  // Skull: an egg from the brow to the back, broad across the crown, a flatter plate across the forehead, and the fuller
  // back of the head. Under the back of the skull it is cut away to the neck.
  const front = Z + 0.004;
  const cy = E + 0.02;
  const midZ = (front + s.back) / 2;
  f.ell([0, cy, midZ], [s.halfW, s.top - cy, (front - s.back) / 2], 0);
  f.pair([0.028, E + 0.064, midZ - 0.012], [s.halfW * 0.64, 0.056, 0.08], 0.03);
  f.ell([0, E + 0.05, Z - 0.03], [s.halfW * 0.84, 0.05, 0.032], 0.03);
  // Temples: the skull is nearly as broad here as above the ears.
  f.pair([s.halfW * 0.62, E + 0.035, Z - 0.05], [s.halfW * 0.36, 0.034, 0.045], 0.025);
  f.ell([0, E + 0.045, s.back + 0.055], [s.halfW * 0.96, 0.068, 0.055], 0.03);
  f.ell([0, E - 0.095, s.back - 0.012], [0.1, 0.05, 0.07], 0.03, true);
  // Midface and lower face: the mass the cheeks, jaw and mouth sit on.
  f.ell([0, E - 0.03, Z - 0.04], [s.cheekbone[0] * 0.86, 0.05, 0.05], 0.03);
  f.ell([0, E - 0.072, Z - 0.05], [s.jaw[0] * 0.88, 0.04, 0.05], 0.03);
  // Cheekbones and the soft cheek below them.
  const [cbx, cby, cbz, cbr] = s.cheekbone;
  f.pair([cbx - cbr * 0.45, E + cby, Z + cbz - cbr * 0.9], [cbr, cbr * 0.7, cbr * 0.95], 0.022);
  const [ckx, cky, ckz, ckr] = s.cheek;
  f.pair([ckx, E + cky, Z + ckz - ckr], [ckr * 0.95, ckr * 1.05, ckr], 0.024);
  // Jaw: the ramus up to the ear, then the body of the mandible round to the chin.
  const [jx, jy, jz] = s.jaw;
  const chinY = E + s.chin.y;
  const chinZ = Z + s.chin.z;
  f.capPair([jx, E + jy, Z + jz], [jx * 0.98, E - 0.028, Z + jz - 0.012], 0.013, 0.014, 0.024);
  f.capPair([jx, E + jy, Z + jz], [s.chin.halfW * 0.7, chinY + 0.011, chinZ - 0.015], 0.0125, 0.012, 0.026);
  f.ell([0, chinY + s.chin.r, chinZ - s.chin.r * 0.95], [s.chin.halfW, s.chin.r, s.chin.r], 0.016);
  // Muzzle: the teeth and the gum under the lips, round in plan.
  f.ell([0, E + m.y + 0.006, Z + m.z - 0.028], [m.halfW + 0.006, 0.026, 0.028], 0.02);
  // Neck, down into the collar.
  f.cap([0, -0.09, s.neck.z], [0, E - 0.05, s.neck.z - 0.006], s.neck.r, s.neck.r * 0.94, 0.03);
  // Brow ridge and the glabella between the brows.
  f.pair([0.025, E + 0.017, Z + s.brow - 0.014], [0.03, 0.0105, 0.014], 0.016);
  f.ell([0, E + 0.013, Z + s.brow - 0.016], [0.016, 0.014, 0.016], 0.014);
  // Eye sockets cut in under the ridge, then the eyeballs under their lids.
  f.pair([X, E + 0.001, Z + 0.006], [0.0195, 0.0145, 0.016], 0.008, true);
  f.pair([X, E - 0.0005, Z - 0.0108], [s.eyeW + 0.0025, 0.0118, 0.011], 0.0045);
  // Nose: bridge, sides, tip, wings, the base under the tip, and the nostrils cut into it.
  const tipY = E + n.tipY;
  const tipZ = Z + n.tipZ;
  const baseY = E + n.baseY;
  f.cap([0, E + 0.004, Z + n.bridge - n.bridgeR], [0, tipY + 0.008, tipZ - 0.011], n.bridgeR, n.bridgeR * 1.35, 0.012);
  f.capPair([0.008, E - 0.004, Z + n.bridge * 0.4 - 0.004], [n.halfW * 0.55, baseY + 0.008, tipZ - 0.024], 0.0045, 0.006, 0.01);
  f.ell([0, tipY, tipZ - n.tipR], [n.tipR * 1.02, n.tipR * 0.92, n.tipR], 0.006);
  f.pair([n.halfW - 0.009, baseY + 0.0064, tipZ - 0.0205], [0.009, 0.0082, 0.0095], 0.0045);
  f.ell([0, baseY + 0.0036, tipZ - 0.0165], [0.0068, 0.0042, 0.0105], 0.004);
  f.pair([0.0068, baseY + 0.0026, tipZ - 0.0185], [0.0041, 0.0022, 0.0055], 0.003, true);
  // Lips: each half is a capsule from the corner to the middle, so the corners can lift independently.
  const lipZ = Z + m.z;
  for (const side of [-1, 1] as const) {
    const lift = m.lift[side < 0 ? 0 : 1];
    const cx = side * m.halfW;
    const cy2 = E + m.y + lift;
    f.cap([cx, cy2 + 0.0012, lipZ - 0.017], [side * 0.004, E + m.y + m.upper * 0.55, lipZ - 0.0035], 0.0022, m.upper * 0.62, 0.0042);
    f.cap([cx * 0.96, cy2 - 0.0012, lipZ - 0.018], [side * 0.004, E + m.y - m.lower * 0.6, lipZ - 0.006], 0.002, m.lower * 0.68, 0.0042);
  }
  // The line between the lips, cut in, and the hollow under the lower lip.
  for (const side of [-1, 1] as const) {
    const lift = m.lift[side < 0 ? 0 : 1];
    f.cap([side * (m.halfW + 0.002), E + m.y + lift, lipZ - 0.02], [0, E + m.y, lipZ - 0.001], 0.0009, 0.001, 0.0016, true);
  }
  f.ell([0, E + m.y - m.lower - 0.009, lipZ - 0.005], [0.013, 0.0042, 0.006], 0.006, true);
  return f;
}

// ------------------------------------------------------------------------------------------ surface grid

export interface Grid {
  /** Ray origin, inside the head. */
  ox: number;
  oy: number;
  oz: number;
  /** Surface point, normal and ray distance per vertex: (GRID_U + 1) x (GRID_V + 1), row-major from the bottom. */
  pos: Float32Array;
  nor: Float32Array;
  rad: Float32Array;
}

function march(f: HeadField, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  let tin = 0;
  let t = 0;
  let d = f.at(ox, oy, oz);
  for (let i = 0; i < 96 && d < 0 && t < 0.4; i++) {
    tin = t;
    t += Math.max(-d * 0.8, 0.0003);
    d = f.at(ox + dx * t, oy + dy * t, oz + dz * t);
  }
  let lo = tin;
  let hi = t;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) * 0.5;
    if (f.at(ox + dx * mid, oy + dy * mid, oz + dz * mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/** Surface normal from the field's gradient (four samples on a tetrahedron). */
function gradient(f: HeadField, x: number, y: number, z: number, out: Float32Array, o: number) {
  const e = 0.0005;
  const k1 = f.at(x + e, y - e, z - e);
  const k2 = f.at(x - e, y - e, z + e);
  const k3 = f.at(x - e, y + e, z - e);
  const k4 = f.at(x + e, y + e, z + e);
  const nx = k1 - k2 - k3 + k4;
  const ny = -k1 - k2 + k3 + k4;
  const nz = -k1 + k2 - k3 + k4;
  const l = Math.hypot(nx, ny, nz) || 1;
  out[o] = nx / l;
  out[o + 1] = ny / l;
  out[o + 2] = nz / l;
}

/** Cast the grid's rays and record where each meets the surface. */
export function sampleGrid(f: HeadField, ox: number, oy: number, oz: number): Grid {
  const n = (GRID_U + 1) * (GRID_V + 1);
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const rad = new Float32Array(n);
  for (let j = 0; j <= GRID_V; j++) {
    const ph = phiAt(j / GRID_V);
    const cp = Math.cos(ph);
    const sp = Math.sin(ph);
    for (let i = 0; i <= GRID_U; i++) {
      const k = j * (GRID_U + 1) + i;
      if (i === GRID_U) {
        // The seam at the back: the same point as the first column, with its own UV.
        const k0 = j * (GRID_U + 1);
        pos.copyWithin(k * 3, k0 * 3, k0 * 3 + 3);
        nor.copyWithin(k * 3, k0 * 3, k0 * 3 + 3);
        rad[k] = rad[k0];
        continue;
      }
      const th = thetaAt(i / GRID_U);
      const dx = cp * Math.sin(th);
      const dy = sp;
      const dz = cp * Math.cos(th);
      const t = march(f, ox, oy, oz, dx, dy, dz);
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      rad[k] = t;
      gradient(f, x, y, z, nor, k * 3);
    }
  }
  return { ox, oy, oz, pos, nor, rad };
}

// ------------------------------------------------------------------------------------------ hair shell

/**
 * How far below the skin the hair shell runs where there is no hair. Near the hairline the shell dips under the skin, so
 * the depth test draws the hairline as a smooth line across the triangles instead of the grid's staircase.
 */
const SINK = 0.0012;

/** Thickness of the hair over a scalp point: the style's top, sides and back, a quiff, clumps, tapering at the hairline. */
function hairDepth(spec: PortraitSpec, mode: HairMode, th: number, ph: number, y: number, ny: number, nz: number): number {
  const h = spec.hair;
  const above = y - hairlineAt(spec, th);
  if (above <= 0) return -SINK;
  const top = clamp01(ny * 1.15);
  const back = clamp01(-nz) * (1 - top);
  const side = Math.max(0, 1 - top - back);
  const rise = smoothstep(0, h.taper, above);
  let t = (h.top * top + h.back * back + h.side * side) * rise;
  if (h.quiff && mode === 'full') {
    const [qa, qe, qw, qh, qt] = h.quiff;
    const da = (th * DEG - qa) / qw;
    const de = (ph * DEG - qe) / qh;
    // Steep at the hairline in front, a long fall over the crown behind.
    const fall = de < 0 ? de : de * 0.55;
    t += qt * Math.exp(-da * da - fall * fall) * smoothstep(0, h.taper * 0.6, above);
  }
  // Clumps: grooves that run along the strands, swept round the head.
  if (h.groove > 0) {
    const along = ph * 9 * h.strand;
    const across = (th + h.sweep * clamp01(ph)) * 26;
    const n = valueNoise3(across, along, 0.5, 71) * 0.7 + valueNoise3(across * 2.3, along * 1.7, 2.5, 72) * 0.3;
    t += (n - 0.45) * h.groove * smoothstep(0, h.taper * 1.5, above);
  }
  return (mode === 'covered' ? Math.min(t, 0.0035) : Math.max(0, t)) - SINK;
}

// ------------------------------------------------------------------------------------------ assembly

/** Full texture size, and the quick one painted in the meantime while a worker paints the full one. */
export const TEX_W = 1024;
export const TEX_H = 1024;
const QUICK = 128;

interface Built {
  spec: PortraitSpec;
  grid: Grid;
  geos: Partial<Record<HairMode, THREE.BufferGeometry>>;
  tex: THREE.DataTexture;
  mat: THREE.MeshStandardMaterial;
  /** Nothing yet, a quick blurry texture while the worker paints, or the full texture. */
  state: 'none' | 'quick' | 'full';
}

const built = new Map<string, Built>();

function faceTexture(data: Uint8Array, w: number, h: number): THREE.DataTexture {
  const tex = shared(new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function prepare(spec: PortraitSpec): Built {
  const hit = built.get(spec.id);
  if (hit && hit.spec === spec) return hit;
  const s = spec.shape;
  const f = headField(s);
  if (spec.beard.depth > 0) {
    // A full beard stands off the skin: thickest at the chin, thinner up the cheeks and round the sides of the jaw.
    const depth = spec.beard.depth;
    f.grow = (x, y, z) => {
      if (y > s.eyeY + 0.02 || z < -0.03) return 0;
      const c = beardCover(spec, x, y, z, true);
      if (c <= 0) return 0;
      const low = 0.5 + 0.5 * smoothstep(s.eyeY - 0.03, s.eyeY + s.chin.y, y);
      const fore = 0.62 + 0.38 * smoothstep(0.01, 0.07, z);
      return depth * smoothstep(0, 0.7, c) * low * fore;
    };
  }
  const grid = sampleGrid(f, 0, rayY(s), RAY_Z);
  const tex = faceTexture(new Uint8Array(TEX_W * TEX_H * 4), TEX_W, TEX_H);
  const mat = shared(new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, roughness: 1, metalness: 0 }));
  mat.onBeforeCompile = (shader) => {
    applyKit(shader, false);
    // Roughness comes from the texture's alpha: wet eyes, lips, skin, hair.
    shader.fragmentShader = shader.fragmentShader.replace('clamp( vSurf.x +', 'clamp( vSurf.x * sampledDiffuseColor.a +');
  };
  mat.customProgramCacheKey = () => 'portrait';
  const b: Built = { spec, grid, geos: {}, tex, mat, state: 'none' };
  // The texture is painted the first time the head is drawn, so a headless game (and every test) never pays for it.
  mat.onBeforeRender = () => {
    if (b.state === 'none') startPainting(b);
  };
  built.set(spec.id, b);
  return b;
}

let worker: Worker | null | undefined;
let jobs = 0;
const waiting = new Map<number, Built>();

/** The worker that paints full textures, made on first use; null where there are no workers (Node, tests) or it failed. */
function paintWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === 'undefined') return null;
  try {
    const w = new Worker(new URL('./portraitPaint.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; data: Uint8Array }>) => {
      const b = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (b) finish(b, e.data.data);
    };
    // If it cannot run at all, paint whatever it was given here instead, and stop using it.
    w.onerror = () => {
      worker = null;
      for (const b of waiting.values()) finish(b, paintTexels(b.spec, b.grid.pos, b.grid.nor, TEX_W, TEX_H));
      waiting.clear();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** A blurry texture now, so the head is never blank, and the full one from the worker as soon as it is done. */
function startPainting(b: Built) {
  const w = paintWorker();
  if (!w) {
    finish(b, paintTexels(b.spec, b.grid.pos, b.grid.nor, TEX_W, TEX_H));
    return;
  }
  b.state = 'quick';
  b.mat.map = faceTexture(paintTexels(b.spec, b.grid.pos, b.grid.nor, QUICK, QUICK), QUICK, QUICK);
  const id = ++jobs;
  waiting.set(id, b);
  const job: PaintJob = { id, spec: b.spec, pos: b.grid.pos, nor: b.grid.nor, w: TEX_W, h: TEX_H };
  w.postMessage(job);
}

function finish(b: Built, data: Uint8Array) {
  (b.tex.image.data as Uint8Array).set(data);
  b.tex.needsUpdate = true;
  const quick = b.mat.map;
  b.mat.map = b.tex;
  if (quick && quick !== b.tex) quick.dispose();
  b.state = 'full';
}

/** The textured skin and hair of a head as one geometry: the grid's surface, and the hair shell grown off it. */
function assemble(b: Built, mode: HairMode): THREE.BufferGeometry {
  const { grid, spec } = b;
  const W = GRID_U + 1;
  const nVert = W * (GRID_V + 1);
  const pos = new Float32Array(nVert * 2 * 3);
  const nor = new Float32Array(nVert * 2 * 3);
  const uv = new Float32Array(nVert * 2 * 2);
  const depth = new Float32Array(nVert);
  pos.set(grid.pos);
  nor.set(grid.nor);
  for (let j = 0; j <= GRID_V; j++) {
    for (let i = 0; i <= GRID_U; i++) {
      const k = j * W + i;
      uv[k * 2] = uv[(nVert + k) * 2] = i / GRID_U;
      uv[k * 2 + 1] = uv[(nVert + k) * 2 + 1] = j / GRID_V;
    }
  }
  // Hair: push each scalp point out along its ray by the hair's depth there.
  for (let j = 0; j <= GRID_V; j++) {
    const ph = phiAt(j / GRID_V);
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const y = grid.pos[k * 3 + 1];
      const d = i === GRID_U ? depth[j * W] : hairDepth(spec, mode, thetaAt(i / GRID_U), ph, y, grid.nor[k * 3 + 1], grid.nor[k * 3 + 2]);
      depth[k] = d;
      const r = grid.rad[k] || 1e-6;
      const sc = (r + d) / r;
      const o = (nVert + k) * 3;
      pos[o] = grid.ox + (grid.pos[k * 3] - grid.ox) * sc;
      pos[o + 1] = grid.oy + (y - grid.oy) * sc;
      pos[o + 2] = grid.oz + (grid.pos[k * 3 + 2] - grid.oz) * sc;
    }
  }
  // Hair normals from its own surface, which is no longer the skin's shape.
  const p = (ii: number, jj: number, c: number) => pos[(nVert + jj * W + ii) * 3 + c];
  for (let j = 0; j <= GRID_V; j++) {
    for (let i = 0; i < W; i++) {
      const o = (nVert + j * W + i) * 3;
      const il = (i - 1 + GRID_U) % GRID_U;
      const ir = (i + 1) % GRID_U;
      const jd = Math.max(0, j - 1);
      const ju = Math.min(GRID_V, j + 1);
      const ux = p(ir, j, 0) - p(il, j, 0);
      const uy = p(ir, j, 1) - p(il, j, 1);
      const uz = p(ir, j, 2) - p(il, j, 2);
      const vx = p(i, ju, 0) - p(i, jd, 0);
      const vy = p(i, ju, 1) - p(i, jd, 1);
      const vz = p(i, ju, 2) - p(i, jd, 2);
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      let l = Math.hypot(nx, ny, nz);
      if (l < 1e-12 || j === 0 || j === GRID_V) {
        nx = pos[o] - grid.ox;
        ny = pos[o + 1] - grid.oy;
        nz = pos[o + 2] - grid.oz;
        l = Math.hypot(nx, ny, nz) || 1;
      }
      // Keep it pointing out of the head.
      const sgn = nx * (pos[o] - grid.ox) + ny * (pos[o + 1] - grid.oy) + nz * (pos[o + 2] - grid.oz) < 0 ? -1 : 1;
      nor[o] = (nx / l) * sgn;
      nor[o + 1] = (ny / l) * sgn;
      nor[o + 2] = (nz / l) * sgn;
    }
  }
  const idx: number[] = [];
  // a (i, j), b (i + 1, j), c (i + 1, j + 1), d (i, j + 1). Columns run toward +x and rows upward, so seen from outside
  // this is counter-clockwise.
  const quad = (a: number, b2: number, c: number, d: number) => idx.push(a, b2, c, a, c, d);
  for (let j = 0; j < GRID_V; j++) {
    for (let i = 0; i < GRID_U; i++) {
      const a = j * W + i;
      quad(a, a + 1, a + W + 1, a + W);
    }
  }
  // Wherever any corner stands above the skin. Corners without hair sit just under it, so the shell meets the skin cleanly.
  for (let j = 0; j < GRID_V; j++) {
    for (let i = 0; i < GRID_U; i++) {
      const a = j * W + i;
      if (Math.max(depth[a], depth[a + 1], depth[a + W], depth[a + W + 1]) <= 0) continue;
      quad(nVert + a, nVert + a + 1, nVert + a + W + 1, nVert + a + W);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nVert * 2 * 3).fill(1), 3));
  // Roughness is scaled by the texture's alpha in the shader; wear kept faint so the kit's grime barely touches a face.
  const srf = new Float32Array(nVert * 2 * 4);
  for (let i = 0; i < nVert * 2; i++) {
    srf[i * 4] = 1;
    srf[i * 4 + 2] = 0.04;
  }
  g.setAttribute('surf', new THREE.BufferAttribute(srf, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return shared(g);
}

/** The skin-and-hair geometry of a portrait head, cached per person and hair mode. */
export function portraitGeometry(spec: PortraitSpec, mode: HairMode): THREE.BufferGeometry {
  const b = prepare(spec);
  return (b.geos[mode] ??= assemble(b, mode));
}

/** The material that draws a portrait head; its texture is painted the first time it is drawn. */
export function portraitMaterial(spec: PortraitSpec): THREE.Material {
  return prepare(spec).mat;
}

/** Paint now, here, rather than on first draw (tools and tests). Returns the RGBA texels, roughness in alpha. */
export function paintPortraitNow(spec: PortraitSpec): Uint8Array {
  const b = prepare(spec);
  if (b.state !== 'full') finish(b, paintTexels(b.spec, b.grid.pos, b.grid.nor, TEX_W, TEX_H));
  return b.tex.image.data as Uint8Array;
}

// ------------------------------------------------------------------------------------------ ears

/** Both ears, vertex-coloured, in the head's frame: a rim rolled over a dished middle, the lobe, the little flap in front. */
export function drawEars(b: MeshBuilder, spec: PortraitSpec) {
  const s = spec.shape;
  const e = s.ear;
  const skin = new THREE.Color(spec.paint.skin).lerp(new THREE.Color(spec.paint.flush), 0.35).getHex();
  const shade = new THREE.Color(spec.paint.skin).lerp(new THREE.Color(spec.paint.shade), 0.55).getHex();
  const S1 = S.skin(skin);
  const S2 = S.skin(shade);
  const h = e.h;
  const w = e.w;
  for (const sx of [-1, 1]) {
    // Built in the ear's own frame, its outer face toward the side it is on: height on Y, front edge at z 0, back toward -Z.
    // Each side is drawn rather than mirrored, so the triangles keep facing out.
    const ear = new MeshBuilder();
    ear.jitter = 0.015;
    const rimPts: [number, number, number][] = [];
    for (let i = 0; i <= 9; i++) {
      const a = lerp(0.35 * Math.PI, 1.62 * Math.PI, i / 9);
      rimPts.push([sx * 0.0035, Math.sin(a) * h * 0.47 - h * 0.02, Math.cos(a) * w * 0.48 - w * 0.5]);
    }
    ear.add('sphere16', sx * 0.0015, -h * 0.03, -w * 0.5, 0.0075, h * 0.92, w * 0.96, S1);
    ear.pipe(rimPts, 0.0034, S1, 8);
    ear.add('sphere16', sx * 0.002, -h * 0.4, -w * 0.48, 0.008, h * 0.26, w * 0.42, S1);
    ear.add('sphere16', sx * 0.0045, -h * 0.04, -w * 0.38, 0.0035, h * 0.4, w * 0.44, S2);
    ear.add('sphere16', sx * 0.001, -h * 0.12, -w * 0.02, 0.008, h * 0.18, 0.01, S1);
    // Tilted back at the top, and turned so the back edge stands out from the skull.
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(sx * (s.halfW - 0.003), s.eyeY + e.top - h * 0.5, s.eyeZ + e.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.12, -sx * e.flare, 0, 'YXZ')),
      new THREE.Vector3(1, 1, 1),
    );
    b.appendMatrix(ear, m);
  }
}
