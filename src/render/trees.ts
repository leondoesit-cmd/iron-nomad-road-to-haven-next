import * as THREE from 'three';
import { GLOBALS } from './materials';
import { shared } from './dispose';
import { LEAF_ATLAS, LEAF_CELL, leafAtlas, spriteAtlasTexture } from './proctex';
import { WIND } from './scatter';
import { hash2 } from '../core/rng';
import { smoothstep } from '../core/math';
import { TREE_DIMS, TREE_SPECIES, woodSpecies, type TreeSpecies, type TreeSpot } from '../world/flora';
import { courseAt, forestAt, lushAt, swampQ, woodsAt } from '../world/hydro';
import { lakeQ } from '../world/lakes';
import { heritageClear } from '../world/heritage';
import { bendClear, bendStems } from '../world/millBend';
import { nearestRoad } from '../world/openWorld';
import type { TerrainDef } from '../world/terrain';

/**
 * The trees of the green country, drawn. Each species is built in code as three variants (trunk and branches as tapered
 * tubes, foliage as alpha-tested leaf-cluster cards from one atlas, so a whole tree is one draw), and the three variants
 * share vertex buffers, with a separate index buffer for each variant. A chunk batches each species/variant, submitting
 * only the selected model's triangles; they sway in the same wind as the grass.
 *
 * Further out every tree is an impostor: three crossed cards showing a picture of the species baked on the CPU from its own
 * model, lit with a domed normal so a wood still reads round. Near and far cross-fade per tree on a dither between
 * `TREE_LOD.near` and `TREE_LOD.far` metres from each view's camera. Beyond the streamed chunks the landscape draws a far
 * forest of the same impostors on a coarse grid (`planFarForest`), which steps aside wherever a chunk is loaded.
 */

export const TREE_LOD = { near: 80, far: 100 };
/** Shared by the 3D trees and the impostors, so the two halves of the cross-fade always agree. */
const LOD_U = { uTreeLod: { value: new THREE.Vector2(TREE_LOD.near, TREE_LOD.far) } };

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const mix3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** `v` turned by `ang` about the unit axis `k` (Rodrigues). */
function turn(v: V3, k: V3, ang: number): V3 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}
/** Two unit axes across a card facing `n`, spun by `spin`. */
function frame(n: V3, spin: number): [V3, V3] {
  const ref: V3 = Math.abs(n[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  const right = norm(cross(ref, n));
  const up = cross(n, right);
  return [turn(right, n, spin), turn(up, n, spin)];
}
function unitRand(r: () => number): V3 {
  const z = r() * 2 - 1;
  const a = r() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return [Math.cos(a) * s, z, Math.sin(a) * s];
}
function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function cellUv(cell: number) {
  const { cols, cell: C, w, h } = LEAF_ATLAS;
  const cx = cell % cols;
  const cy = Math.floor(cell / cols);
  const inset = 2;
  // v runs down the image: v0 is the top of the cell (the atlas is a DataTexture, row 0 first).
  return { u0: (cx * C + inset) / w, u1: ((cx + 1) * C - inset) / w, v0: (cy * C + inset) / h, v1: ((cy + 1) * C - inset) / h };
}

const _col = new THREE.Color();

// ---------------------------------------------------------------------------------------- the kit

/**
 * Accumulates one species' geometry: tubes for wood and strips of cards for foliage. Every vertex carries `tree`: (how much
 * it flutters, 0 for wood; which variant it belongs to; a flutter phase).
 */
class TreeKit {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  tree: number[] = [];
  idx: number[] = [];
  variant = 0;
  /** Convex pieces of the actual wood rings, for a fallen tree's compound rigid body. */
  woodHulls: { variant: number; vertices: Float32Array }[] = [];

  private rgb(hex: number, k: number): V3 {
    _col.setHex(hex);
    return [_col.r * k, _col.g * k, _col.b * k];
  }

  /**
   * A tapered tube through `pts` with radius `rad[i]` at each point and `seg` sides, wrapped in bark (`cell`, the plain
   * fissured bark unless told otherwise). `flute` ripples the radius round the ring (a buttressed foot), `ring` shades a ring
   * (a palm's leaf scars). Darker at the foot.
   */
  tube(pts: V3[], rad: number[], seg: number, hex: number, o: { flute?: (i: number, a: number) => number; ring?: (i: number) => number; cell?: number } = {}) {
    const n = pts.length;
    const { u0, u1, v0, v1 } = cellUv(o.cell ?? LEAF_CELL.bark);
    const L = [0];
    for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(...sub(pts[i], pts[i - 1])));
    const t0 = norm(sub(pts[1], pts[0]));
    let N = norm(cross(Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], t0));
    const base = this.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const t = norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]));
      N = norm(sub(N, mul(t, dot(N, t))));
      const B = cross(t, N);
      const c = this.rgb(hex, (o.ring?.(i) ?? 1) * (0.62 + 0.38 * Math.min(1, Math.max(0, pts[i][1]) / 1.8)));
      // Bark ping-pongs every 4 m along the tube so a tall trunk is not one smear of the cell.
      const ph = (L[i] / 4) % 2;
      const vv = v0 + (v1 - v0) * (ph > 1 ? 2 - ph : ph);
      for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const d = add(mul(N, Math.cos(a)), mul(B, Math.sin(a)));
        const r = rad[i] * (o.flute ? o.flute(i, a) : 1);
        const p = add(pts[i], mul(d, r));
        this.pos.push(...p);
        this.nor.push(...d);
        this.uv.push(u0 + ((u1 - u0) * j) / seg, vv);
        this.col.push(...c);
        this.tree.push(0, this.variant, 0);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      this.woodHulls.push({ variant: this.variant, vertices: Float32Array.from(this.pos.slice((base + i * (seg + 1)) * 3, (base + (i + 2) * (seg + 1)) * 3)) });
      for (let j = 0; j < seg; j++) {
        const a = base + i * (seg + 1) + j;
        const b = a + 1;
        const c = a + seg + 1;
        const d = c + 1;
        this.idx.push(a, b, c, b, d, c);
      }
    }
  }

  /**
   * A strip of foliage card along `pts`, `hw[i]` either side along `side[i]`. The atlas cell runs down the strip ('v': the
   * top of the picture at the first point) or along it ('u': the left of the picture at the first point, as a palm frond).
   * Normals bend toward the crown's ellipsoid (centre `C`, radii `R`) so the crown shades as one round mass, and the colour
   * darkens toward its heart and underside.
   */
  strip(pts: V3[], side: V3[], hw: number[], cell: number, along: 'u' | 'v', hex: number, tone: number, flutter: number[], C: V3, R: V3, phase: number) {
    const n = pts.length;
    const { u0, u1, v0, v1 } = cellUv(cell);
    const L = [0];
    for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(...sub(pts[i], pts[i - 1])));
    const total = L[n - 1] || 1;
    const base = this.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const tg = norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]));
      const f = L[i] / total;
      for (const s of [-1, 1]) {
        const p = add(pts[i], mul(side[i], hw[i] * s));
        const q: V3 = [(p[0] - C[0]) / R[0], (p[1] - C[1]) / R[1], (p[2] - C[2]) / R[2]];
        const e = Math.hypot(q[0], q[1], q[2]);
        const sph = norm([q[0] / R[0], q[1] / R[1], q[2] / R[2]]);
        let face = norm(cross(side[i], tg));
        if (dot(face, sph) < 0) face = mul(face, -1);
        this.pos.push(...p);
        this.nor.push(...norm(add(mul(sph, 0.72), mul(face, 0.28))));
        if (along === 'v') this.uv.push(s < 0 ? u0 : u1, v0 + (v1 - v0) * f);
        else this.uv.push(u0 + (u1 - u0) * f, s < 0 ? v0 : v1);
        const ao = (0.5 + 0.5 * smoothstep(0.1, 1, e)) * (0.8 + 0.2 * Math.min(1, Math.max(0, q[1] * 0.5 + 0.5)));
        this.col.push(...this.rgb(hex, tone * ao));
        this.tree.push(flutter[i], this.variant, phase);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }

  /** One card centred at `c`: `w` wide along `right`, `h` tall along `up` (the top of the picture toward +up). */
  card(c: V3, right: V3, up: V3, w: number, h: number, cell: number, hex: number, tone: number, flutter: number, C: V3, R: V3, phase: number) {
    this.strip([add(c, mul(up, h / 2)), add(c, mul(up, -h / 2))], [right, right], [w / 2, w / 2], cell, 'v', hex, tone, [flutter, flutter * 0.6], C, R, phase);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('tree', new THREE.Float32BufferAttribute(this.tree, 3));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.userData.woodHulls = this.woodHulls;
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return shared(g);
  }
}

/** A limb from `a` along `dir`, kinked in the middle and sagging a little: returns its end. */
function limb(k: TreeKit, r: () => number, a: V3, dir: V3, len: number, r0: number, r1: number, seg: number, hex: number, droop = 0): V3 {
  const d = norm(dir);
  const mid = add(a, mul(d, len * 0.5));
  mid[0] += (r() - 0.5) * len * 0.18;
  mid[2] += (r() - 0.5) * len * 0.18;
  mid[1] -= droop * len * 0.12;
  const end = add(a, mul(d, len));
  end[1] -= droop * len * 0.35;
  k.tube([a, mid, end], [r0, (r0 + r1) / 2, r1], seg, hex);
  return end;
}

/**
 * Surface roots: `n` of them flaring off the foot of a trunk `rb` thick, humped over the ground for `reach` metres and diving
 * into it, so a tree on a river bank stands on a tangle of them where the water has washed the soil from under it.
 */
function roots(k: TreeKit, r: () => number, n: number, rb: number, reach: number, hex: number, cell?: number) {
  const a0 = r() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + (r() - 0.5) * 0.7;
    const L = reach * (0.65 + r() * 0.55);
    const c = Math.cos(a);
    const s = Math.sin(a);
    const at = (d: number, y: number): V3 => [c * d, y, s * d];
    k.tube([at(rb * 0.45, 0.55), at(rb + L * 0.22, 0.2 + r() * 0.12), at(rb + L * 0.6, 0.04 + r() * 0.06), at(rb + L, -0.6)], [rb * 0.42, rb * 0.3, rb * 0.17, 0.03], 4, hex, { cell });
  }
}

/** A clump of leaf cards round `centre`, pushed toward the outside of the crown, mostly facing out of it. */
function clump(k: TreeKit, r: () => number, centre: V3, rad: number, n: number, C: V3, R: V3, cell: number, hex: number, w0: number, w1: number) {
  for (let i = 0; i < n; i++) {
    const d = unitRand(r);
    const p = add(centre, mul(d, rad * (0.35 + 0.65 * Math.sqrt(r()))));
    const out = norm(sub(p, C));
    const [right, up] = frame(norm(add(mul(out, 0.6), mul(unitRand(r), 0.8))), r() * Math.PI * 2);
    const s = w0 + r() * (w1 - w0);
    p[1] = Math.max(p[1], s * 0.5 + 0.4);
    k.card(p, right, up, s, s, cell, hex, 0.85 + r() * 0.25, 1, C, R, r());
  }
}

// ---------------------------------------------------------------------------------------- species

type Grow = (k: TreeKit, r: () => number, v: number) => void;

/** Oak and terebinth: a stout bole parting into three or four limbs under a broad, lumpy round crown. */
const oak: Grow = (k, r, v) => {
  const D = TREE_DIMS.oak;
  const bark = 0x5b4f44;
  const leaf = v === 2 ? 0x5a7330 : 0x4f6e2b;
  const lean = v === 2 ? 0.9 : 0.4;
  const lx = (r() - 0.5) * lean;
  const lz = (r() - 0.5) * lean;
  const bole = D.bole * (0.9 + r() * 0.2);
  const top: V3 = [lx, bole, lz];
  k.tube([[0, -0.3, 0], [lx * 0.15, 0.9, lz * 0.15], [lx * 0.55, bole * 0.62, lz * 0.55], top], [D.trunk * 1.45, D.trunk * 1.05, D.trunk * 0.92, D.trunk * 0.8], 8, bark);
  for (let i = 0; i < 4; i++) {
    const a = i * 1.57 + r() * 0.6;
    k.tube([[0, 0.55, 0], [Math.cos(a) * 1.0, -0.05, Math.sin(a) * 1.0]], [D.trunk * 0.55, 0.05], 4, bark);
  }
  const wide = v === 1 ? 0.9 : 1;
  const C: V3 = [lx, bole + 3 + v * 0.3, lz];
  const R: V3 = [D.crown * wide, 3 + v * 0.25, D.crown * wide];
  const n = v === 1 ? 4 : 3;
  const blobs: [V3, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.8;
    const out = (0.55 + r() * 0.25) * wide;
    const end = limb(k, r, top, [Math.cos(a) * out, 0.8, Math.sin(a) * out], 2.8 + r() * 0.9, D.trunk * 0.62, D.trunk * 0.3, 6, bark);
    const subs = 2 + (r() < 0.5 ? 1 : 0);
    for (let j = 0; j < subs; j++) {
      const b = a + (j - (subs - 1) / 2) * 0.9 + (r() - 0.5) * 0.4;
      const e2 = limb(k, r, end, [Math.cos(b) * 0.8 * wide, 0.45 + r() * 0.35, Math.sin(b) * 0.8 * wide], 1.6 + r() * 0.9, D.trunk * 0.26, 0.04, 4, bark);
      blobs.push([e2, 1.5 + r() * 0.6]);
    }
  }
  blobs.push([[C[0], C[1] + R[1] * 0.55, C[2]], 1.9], [[C[0], C[1] - 0.2, C[2]], 2.2]);
  for (const [bc, br] of blobs) clump(k, r, bc, br, 7, C, R, LEAF_CELL.broad, leaf, 1.9, 2.6);
};

/** Pine: a straight tapering trunk under whorls of boughs that shorten to a pointed top, needle sprays laid along them. */
const pine: Grow = (k, r, v) => {
  const D = TREE_DIMS.pine;
  const bark = 0x6a4a36;
  const leaf = 0x31502f;
  const h = D.h * (v === 1 ? 1.08 : v === 2 ? 0.95 : 1);
  const y0 = v === 2 ? 6.5 : 4.2 + r() * 0.6;
  const crown = D.crown * (v === 1 ? 0.85 : v === 2 ? 1.1 : 1);
  const at = (y: number): V3 => [Math.sin(y * 0.35 + v) * 0.12, y, Math.cos(y * 0.29 + v) * 0.1];
  const tp: V3[] = [];
  const tr: number[] = [];
  for (let i = 0; i <= 6; i++) {
    const y = (i / 6) * h;
    tp.push(i === 0 ? [0, -0.3, 0] : at(y));
    tr.push(D.trunk * (i === 0 ? 1.3 : 1) * (1 - (i / 6) * 0.88));
  }
  k.tube(tp, tr, 7, bark);
  const C: V3 = [0, (y0 + h) / 2, 0];
  const R: V3 = [crown, (h - y0) / 2 + 0.5, crown];
  const whorls = Math.max(4, Math.round((h - 1.2 - y0) / 1.15));
  for (let w = 0; w <= whorls; w++) {
    const y = y0 + w * ((h - 1.2 - y0) / whorls);
    const f = (y - y0) / (h - y0);
    const nb = 4 + (r() < 0.5 ? 1 : 0);
    const a0 = r() * Math.PI * 2;
    for (let b = 0; b < nb; b++) {
      const a = a0 + (b / nb) * Math.PI * 2 + (r() - 0.5) * 0.5;
      const L = crown * Math.pow(1 - f, 0.85) * (0.8 + r() * 0.35) + 0.45;
      // Lower boughs droop, upper ones lift.
      const dir = norm([Math.cos(a), 0.18 - 0.3 * (1 - f), Math.sin(a)]);
      const base = at(y);
      if (w < whorls * 0.6) k.tube([base, add(base, mul(dir, L))], [0.08 * (1 - f) + 0.03, 0.02], 3, bark);
      // Needle sprays along the bough, crossed in pairs about it so a pine reads full from the ground as well as from above.
      const side = norm(cross(dir, [0, 1, 0]));
      for (const t of [0.45, 0.85]) {
        const p = add(base, mul(dir, L * t));
        const tilt = 0.45 + (r() - 0.5) * 0.4;
        const w = 1.6 + r() * 0.5 + L * 0.2;
        const len = L * 0.6 + 0.7;
        for (const tt of [tilt, tilt - Math.PI / 2]) k.card(p, turn(side, dir, tt), dir, w, len, LEAF_CELL.needle, leaf, 0.85 + r() * 0.25, 0.7, C, R, r());
      }
    }
  }
  for (let i = 0; i < 3; i++) {
    const a = i * 2.094 + r();
    k.card(at(h - 0.8), [Math.cos(a), 0, Math.sin(a)], [0, 1, 0], 1.1, 1.8, LEAF_CELL.needle, leaf, 0.95, 0.5, C, R, r());
  }
};

/** Weeping willow: a thick leaning bole, arching limbs, and curtains of leafy strands hanging almost to the ground. */
const willow: Grow = (k, r, v) => {
  const D = TREE_DIMS.willow;
  const bark = 0x5a5042;
  const leaf = 0x7f9b48;
  const lx = (r() - 0.5) * 1.2;
  const lz = (r() - 0.5) * 1.2;
  const bole = D.bole * (0.9 + r() * 0.25);
  const top: V3 = [lx, bole, lz];
  k.tube([[0, -0.3, 0], [lx * 0.3, bole * 0.5, lz * 0.3], top], [D.trunk * 1.4, D.trunk * 1.05, D.trunk * 0.9], 8, bark);
  roots(k, r, 5, D.trunk * 1.25, 2.0, bark);
  const C: V3 = [lx, 5.6 + v * 0.3, lz];
  const R: V3 = [D.crown * (v === 2 ? 1.1 : 1), 3.2, D.crown * (v === 2 ? 1.1 : 1)];
  const n = 4 + (v === 1 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.7;
    const e = limb(k, r, top, [Math.cos(a) * 0.55, 0.85, Math.sin(a) * 0.55], 3.0 + r() * 0.8, D.trunk * 0.55, D.trunk * 0.25, 5, bark);
    limb(k, r, e, [Math.cos(a) * 0.9, 0.3, Math.sin(a) * 0.9], 1.8 + r() * 0.6, D.trunk * 0.25, 0.04, 4, bark, 0.6);
  }
  for (let i = 0; i < 12; i++) {
    const d = unitRand(r);
    d[1] = Math.abs(d[1]) * 0.7 + 0.2;
    const p: V3 = [C[0] + d[0] * R[0] * 0.75, C[1] + d[1] * R[1] * 0.85, C[2] + d[2] * R[2] * 0.75];
    const [right, up] = frame(norm(add(d, [0, 0.8, 0])), r() * Math.PI * 2);
    const s = 1.8 + r() * 0.6;
    k.card(p, right, up, s, s, LEAF_CELL.poplar, leaf, 0.9 + r() * 0.2, 1, C, R, r());
  }
  const N = 38;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 4 + r() * 0.3;
    const outer = i % 2 === 0;
    const rr = R[0] * (outer ? 0.78 + r() * 0.22 : 0.4 + r() * 0.3);
    const yTop = C[1] + R[1] * Math.sqrt(Math.max(0, 1 - (rr / R[0]) ** 2)) * 0.85 + 0.2;
    const len = Math.min(yTop - 1.1, 3.6 + r() * 1.8);
    const out: V3 = [Math.cos(a), 0, Math.sin(a)];
    const t0: V3 = [C[0] + out[0] * rr, yTop, C[2] + out[2] * rr];
    const side: V3 = [-Math.sin(a), 0, Math.cos(a)];
    const w = 0.6 + r() * 0.25;
    k.strip([t0, add(t0, [out[0] * 0.35, -len * 0.5, out[2] * 0.35]), add(t0, [out[0] * 0.25, -len, out[2] * 0.25])], [side, side, side], [w, w, w * 0.9], LEAF_CELL.strands, 'v', leaf, 0.85 + r() * 0.25, [0.3, 1.3, 2.4], C, R, r());
  }
};

/** Lombardy poplar: a tall narrow column of small leaves on upswept branches. */
const poplar: Grow = (k, r, v) => {
  const D = TREE_DIMS.poplar;
  const bark = 0x8b8577;
  const leaf = 0x56792f;
  const h = D.h * (0.92 + v * 0.06);
  const crown = D.crown * (v === 2 ? 1.15 : 1);
  const tp: V3[] = [];
  const tr: number[] = [];
  for (let i = 0; i <= 5; i++) {
    const y = (i / 5) * (h - 0.4);
    tp.push(i === 0 ? [0, -0.3, 0] : [Math.sin(y * 0.4 + v) * 0.08, y, Math.cos(y * 0.33) * 0.06]);
    tr.push(D.trunk * (i === 0 ? 1.25 : 1) * (1 - (i / 5) * 0.85));
  }
  k.tube(tp, tr, 7, bark);
  for (let i = 0; i < 12; i++) {
    const y = 2.2 + (i / 12) * h * 0.75;
    const a = i * 2.4 + r() * 0.4;
    const p: V3 = [0, y, 0];
    k.tube([p, add(p, mul(norm([Math.cos(a) * 0.32, 0.95, Math.sin(a) * 0.32]), 1.4 + r()))], [0.07, 0.02], 3, bark);
  }
  const y0 = 1.6;
  const prof = (y: number) => {
    const f = (y - y0) / (h - y0);
    return f <= 0 || f >= 1 ? 0 : crown * Math.pow(Math.sin(Math.PI * Math.pow(f, 0.7)), 0.85);
  };
  const C: V3 = [0, (y0 + h) / 2, 0];
  const R: V3 = [crown, (h - y0) / 2, crown];
  for (let i = 0; i < 74; i++) {
    const y = y0 + 0.6 + r() * (h - y0 - 0.9);
    const a = r() * Math.PI * 2;
    const rad = prof(y) * (0.4 + 0.6 * Math.sqrt(r()));
    const tilt = 0.2 + r() * 0.35;
    const up = norm([Math.cos(a) * tilt, 1, Math.sin(a) * tilt]);
    const right = turn(norm([-Math.sin(a), 0, Math.cos(a)]), up, (r() - 0.5) * 0.8);
    k.card([Math.cos(a) * rad, y, Math.sin(a) * rad], right, up, 1.3 + r() * 0.5, 1.9 + r() * 0.6, LEAF_CELL.poplar, leaf, 0.85 + r() * 0.25, 1, C, R, r());
  }
};

/** Date palm: a ringed, gently bowed trunk, a crown of long arching fronds and a skirt of dead ones. */
const palm: Grow = (k, r, v) => {
  const D = TREE_DIMS.palm;
  const bark = 0x6e5a44;
  const frond = 0x6a8a3e;
  const dead = 0x8c6c3e;
  const ht = 7.4 + v * 0.45 + r() * 0.4;
  const ba = r() * Math.PI * 2;
  const bend = 0.5 + r() * 0.7;
  const P = (t: number): V3 => [Math.cos(ba) * bend * t * t, t * ht, Math.sin(ba) * bend * t * t];
  const pts: V3[] = [];
  const rad: number[] = [];
  for (let i = 0; i <= 11; i++) {
    const t = i / 11;
    pts.push(i === 0 ? [0, -0.3, 0] : P(t));
    rad.push(i === 0 ? D.trunk * 1.6 : i === 1 ? D.trunk * 1.15 : D.trunk * (1 - t * 0.12));
  }
  k.tube(pts, rad, 8, bark, { ring: (i) => (i % 2 ? 0.78 : 1) });
  const top = P(1);
  k.tube([add(top, [0, -0.5, 0]), add(top, [0, 0.35, 0]), add(top, [0, 0.8, 0])], [0.34, 0.36, 0.16], 8, 0x7a5f3e);
  const H0 = add(top, [0, 0.55, 0]);
  const C: V3 = add(H0, [0, 0.2, 0]);
  const R: V3 = [D.crown, 2.2, D.crown];
  const nf = 18 + v * 2;
  for (let i = 0; i < nf; i++) {
    const a = i * 2.39996 + r() * 0.2;
    const f = i / nf;
    const e = 1.05 - f * 1.05 + (r() - 0.5) * 0.15;
    const L = 3.6 + r() * 0.9;
    const droop = 0.45 + r() * 0.25;
    const side: V3 = [-Math.sin(a), 0, Math.cos(a)];
    const fp: V3[] = [];
    const fl: number[] = [];
    for (let s = 0; s <= 4; s++) {
      const t = s / 4;
      const x = L * t * Math.cos(e);
      fp.push([H0[0] + Math.cos(a) * x, H0[1] + L * t * Math.sin(e) - droop * L * t * t, H0[2] + Math.sin(a) * x]);
      fl.push(t * t * 1.6);
    }
    k.strip(fp, [side, side, side, side, side], [0.65, 0.65, 0.65, 0.65, 0.65], LEAF_CELL.frond, 'u', frond, 0.85 + r() * 0.25, fl, C, R, r());
  }
  for (let i = 0; i < 5 + v; i++) {
    const a = r() * Math.PI * 2;
    const L = 2.6 + r() * 0.8;
    const side: V3 = [-Math.sin(a), 0, Math.cos(a)];
    const s0 = add(H0, [0, -0.45, 0]);
    const fp: V3[] = [s0, add(s0, [Math.cos(a) * 0.45, -L * 0.35, Math.sin(a) * 0.45]), add(s0, [Math.cos(a) * 0.6, -L, Math.sin(a) * 0.6])];
    k.strip(fp, [side, side, side], [0.5, 0.55, 0.5], LEAF_CELL.frond, 'u', dead, 0.8 + r() * 0.2, [0, 0.3, 0.6], C, R, r());
  }
};

/** Umbrella-thorn acacia: a short trunk forking into spreading stems under a wide, flat-topped canopy. */
const acacia: Grow = (k, r, v) => {
  const D = TREE_DIMS.acacia;
  const bark = 0x4c4036;
  const leaf = 0x74874a;
  const yf = 1.0 + r() * 0.7;
  const fork: V3 = [(r() - 0.5) * 0.3, yf, (r() - 0.5) * 0.3];
  k.tube([[0, -0.3, 0], [fork[0] * 0.5, yf * 0.5, fork[2] * 0.5], fork], [D.trunk * 1.4, D.trunk * 1.1, D.trunk], 6, bark);
  const yc = D.h * (0.86 + v * 0.04) - 0.3;
  const crown = D.crown * (v === 2 ? 1.12 : v === 1 ? 0.9 : 1);
  const C: V3 = [0, yc - 0.4, 0];
  const R: V3 = [crown, 1.1, crown];
  const ns = 2 + (r() < 0.6 ? 1 : 0);
  for (let i = 0; i < ns; i++) {
    const a = (i / ns) * Math.PI * 2 + r() * 0.8;
    const out = 1.4 + r() * 0.9;
    const st: V3 = [Math.cos(a) * out, yc - 0.6, Math.sin(a) * out];
    k.tube([fork, [fork[0] + Math.cos(a) * out * 0.45, (yf + yc) * 0.5, fork[2] + Math.sin(a) * out * 0.45], st], [D.trunk * 0.85, D.trunk * 0.6, D.trunk * 0.42], 5, bark);
    for (let j = 0; j < 3; j++) {
      const b = a + (j - 1) * 0.8 + (r() - 0.5) * 0.4;
      const reach = crown * (0.55 + r() * 0.35);
      const end: V3 = [Math.cos(b) * reach, yc - 0.15 + r() * 0.3, Math.sin(b) * reach];
      k.tube([st, add(mix3(st, end, 0.5), [0, 0.15, 0]), end], [D.trunk * 0.35, 0.05, 0.025], 3, bark);
    }
  }
  for (let i = 0; i < 46; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * crown * 0.92;
    const edge = d / crown;
    const p: V3 = [Math.cos(a) * d, yc + (r() - 0.35) * 0.55 + 0.25 * (1 - edge * edge) - edge * edge * 0.25, Math.sin(a) * d];
    const tiltOut = edge * 0.35 + (r() - 0.5) * 0.25;
    const n = norm([Math.cos(a) * tiltOut + (r() - 0.5) * 0.2, 1, Math.sin(a) * tiltOut + (r() - 0.5) * 0.2]);
    const [right, up] = frame(n, r() * Math.PI * 2);
    const s = 1.9 + r() * 0.8;
    k.card(p, right, up, s, s, LEAF_CELL.acacia, leaf, 0.85 + r() * 0.25, 0.6, C, R, r());
  }
};

/** Swamp (bald) cypress: a fluted, buttressed foot with knees round it, a sparse crown of feathery sprays and hanging moss. */
const cypress: Grow = (k, r, v) => {
  const D = TREE_DIMS.cypress;
  const bark = 0x5f554b;
  const leaf = v === 2 ? 0x8d6a34 : 0x5c7b34;
  const moss = 0x7c8270;
  const h = D.h * (0.9 + r() * 0.2);
  const ph = r() * Math.PI * 2;
  const ys = [-0.3, 0.35, 1.0, 2.2, 4.5, 7.5, h - 0.6];
  const rs = [1.35, 1.0, 0.7, 0.55, 0.44, 0.3, 0.07].map((q) => (q * D.trunk) / 0.5);
  const tp = ys.map((y, i): V3 => [Math.sin(y * 0.3 + ph) * 0.15 * (i / 6), y, Math.cos(y * 0.25 + ph) * 0.12 * (i / 6)]);
  const fl = [0.45, 0.4, 0.22, 0.08, 0, 0, 0];
  k.tube(tp, rs, 10, bark, { flute: (i, a) => 1 + fl[i] * Math.max(-0.5, Math.cos(a * 5 + ph)) });
  for (let i = 0; i < 5; i++) {
    const a = r() * Math.PI * 2;
    const d = 1.8 + r() * 1.6;
    k.tube([[Math.cos(a) * d, -0.1, Math.sin(a) * d], [Math.cos(a) * d + 0.05, 0.3 + r() * 0.45, Math.sin(a) * d]], [0.13, 0.03], 4, bark);
  }
  const C: V3 = [0, h * 0.62, 0];
  const R: V3 = [D.crown, h * 0.36, D.crown];
  const nb = 11;
  for (let i = 0; i < nb; i++) {
    const y = 4.2 + (i / nb) * (h - 5.2) + (r() - 0.5) * 0.4;
    const f = (y - 4) / (h - 4);
    const a = i * 2.2 + r() * 0.7;
    const L = D.crown * (1 - f * 0.55) * (0.6 + r() * 0.5);
    const dir = norm([Math.cos(a), 0.05 + r() * 0.25, Math.sin(a)]);
    const base: V3 = [0, y, 0];
    const end = limb(k, r, base, dir, L, 0.09 * (1 - f) + 0.03, 0.025, 4, bark, 0.25);
    const side = norm(cross(dir, [0, 1, 0]));
    const ns = 2 + Math.floor(r() * 2.5);
    for (let s = 0; s < ns; s++) {
      const p = mix3(base, end, 0.4 + (s / ns) * 0.6);
      p[1] -= 0.15;
      const tilt = (r() - 0.5) * 0.8;
      const up = norm([dir[0], dir[1] - 0.25, dir[2]]);
      const w = 1.5 + r() * 0.5;
      const len = 1.7 + r() * 0.6;
      for (const tt of [tilt + 0.5, tilt - 1.0]) k.card(p, turn(side, up, tt), up, w, len, LEAF_CELL.feather, leaf, 0.85 + r() * 0.25, 1, C, R, r());
    }
    if (r() < 0.65) {
      const p = mix3(base, end, 0.5 + r() * 0.4);
      const len = 1.2 + r() * 1.3;
      const sa = r() * Math.PI;
      const ms: V3 = [Math.cos(sa), 0, Math.sin(sa)];
      k.strip([p, add(p, [0, -len * 0.5, 0]), add(p, [0.1, -len, 0.05])], [ms, ms, ms], [0.3, 0.32, 0.25], LEAF_CELL.strands, 'v', moss, 0.9 + r() * 0.2, [0.2, 1, 1.8], C, R, r());
    }
  }
  for (let i = 0; i < 3; i++) {
    const a = i * 2.094 + r();
    k.card([0, h - 1.0, 0], [Math.cos(a), 0, Math.sin(a)], [0, 1, 0], 1.3, 1.8, LEAF_CELL.feather, leaf, 0.95, 0.6, C, R, r());
  }
};

/** A dead snag: a pale, broken-topped trunk with a few bare limbs, some snapped short; swamp ones trail moss. */
const snag: Grow = (k, r, v) => {
  const D = TREE_DIMS.snag;
  const wood = 0x8a8070;
  const moss = 0x7c8270;
  const ht = D.h * (0.62 + r() * 0.15) * (v === 2 ? 0.6 : 1);
  const lx = (r() - 0.5) * 0.8;
  const lz = (r() - 0.5) * 0.8;
  const tp: V3[] = [];
  const tr: number[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    tp.push(i === 0 ? [0, -0.3, 0] : [lx * t * t + (r() - 0.5) * 0.1, ht * t, lz * t * t + (r() - 0.5) * 0.1]);
    tr.push(D.trunk * (i === 0 ? 1.35 : 1 - t * 0.45));
  }
  k.tube(tp, tr, 7, wood);
  const crownTop = tp[4];
  for (let i = 0; i < 3; i++) {
    const a = r() * Math.PI * 2;
    k.tube([add(crownTop, [Math.cos(a) * 0.08, -0.05, Math.sin(a) * 0.08]), add(crownTop, [Math.cos(a) * 0.15, 0.3 + r() * 0.6, Math.sin(a) * 0.15])], [0.07, 0.01], 3, wood);
  }
  const C: V3 = [lx * 0.5, ht * 0.65, lz * 0.5];
  const R: V3 = [D.crown, ht * 0.4, D.crown];
  const nb = v === 2 ? 1 : 3 + Math.floor(r() * 2);
  for (let i = 0; i < nb; i++) {
    const t = 0.35 + r() * 0.55;
    const base: V3 = [lx * t * t, ht * t, lz * t * t];
    const a = r() * Math.PI * 2;
    const snapped = r() < 0.3;
    const len = (1.4 + r() * 1.6) * (snapped ? 0.4 : 1);
    const end = limb(k, r, base, [Math.cos(a) * 0.8, 0.55 + r() * 0.4, Math.sin(a) * 0.8], len, 0.13, 0.05, 5, wood);
    if (!snapped) {
      for (let j = 0; j < 2; j++) {
        const b = a + (j ? 0.7 : -0.7);
        limb(k, r, end, [Math.cos(b) * 0.7, 0.6, Math.sin(b) * 0.7], len * 0.55, 0.05, 0.015, 3, wood);
      }
    }
    if (v === 1) {
      const ms: V3 = [-Math.sin(a), 0, Math.cos(a)];
      const p = mix3(base, end, 0.7);
      k.strip([p, add(p, [0, -0.8, 0]), add(p, [0.05, -1.6, 0])], [ms, ms, ms], [0.28, 0.3, 0.22], LEAF_CELL.strands, 'v', moss, 0.9, [0.2, 1, 1.6], C, R, r());
    }
  }
};

/** A eucalyptus's leaves: a few sprays hanging off a twig end like curtains, and two cards across them so they read from any side. */
function gumSpray(k: TreeKit, r: () => number, p: V3, C: V3, R: V3, hex: number) {
  const n = 3 + (r() < 0.45 ? 1 : 0);
  const a0 = r() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + (r() - 0.5) * 0.7;
    const out: V3 = [Math.cos(a), 0, Math.sin(a)];
    const side: V3 = [-Math.sin(a), 0, Math.cos(a)];
    const reach = 0.3 + r() * 0.5;
    const t0 = add(p, [out[0] * reach, 0.35 + r() * 0.5, out[2] * reach]);
    const len = 1.9 + r() * 1.5;
    const w = 0.55 + r() * 0.3;
    k.strip([t0, add(t0, [out[0] * 0.35, -len * 0.5, out[2] * 0.35]), add(t0, [out[0] * 0.5, -len, out[2] * 0.5])], [side, side, side], [w, w * 1.05, w * 0.85], LEAF_CELL.gum, 'v', hex, 0.85 + r() * 0.25, [0.3, 1.1, 2.0], C, R, r());
  }
  for (let i = 0; i < 2; i++) {
    const d = sub(p, C);
    const a = Math.atan2(d[2], d[0]) + (r() - 0.5) * 1.2 + (i ? Math.PI / 2 : 0);
    const right: V3 = [-Math.sin(a), 0, Math.cos(a)];
    const up = norm([Math.cos(a) * 0.15, 1, Math.sin(a) * 0.15]);
    const s = 2.0 + r() * 0.7;
    k.card(add(p, [0, -0.45 - r() * 0.4, 0]), right, up, s, s * 1.15, LEAF_CELL.gum, hex, 0.8 + r() * 0.25, 1, C, R, r());
  }
}

/**
 * River red gum (eucalyptus), as the Yarkon is lined with, in three shapes that do not look alike. Variant 0 is the old red gum:
 * a massive short bole, rough and brownish to a few metres up, parting low into four great sinuous pale limbs that sweep out
 * into a broad, open, weeping crown. Variant 1 is the many-stemmed clump. Variant 2 is the V: a short bole forking at head
 * height into two tall stems leaning apart, smooth-barked and shedding. The leaves hang in loose drooping sprays at the twig
 * ends, an open crown with the sky through it. Each tree's bark takes its own colour in the shader (white, cream, salmon,
 * grey-brown), so the same shape never looks twice the same.
 */
const eucalyptus: Grow = (k, r, v) => {
  const D = TREE_DIMS.eucalyptus;
  const bark = 0xcfcac0;
  const rough = 0x9a8a78;
  const leaf = 0x5f7350;
  const cell = LEAF_CELL.gumBark;
  const h = D.h * (v === 0 ? 0.9 : v === 1 ? 0.94 : 1.04);
  const crown = D.crown * (v === 0 ? 1.4 : v === 1 ? 1.12 : 0.92);
  const C: V3 = [0, h * (v === 0 ? 0.64 : 0.7), 0];
  const R: V3 = [crown, h * 0.28, crown];
  const sprays: V3[] = [];
  const a0 = r() * Math.PI * 2;
  /** One stem from `foot` leaning `lean` toward `a`, forking at `fork` into `nL` limbs spread `spread` wide. */
  const stem = (foot: V3, a: number, lean: number, hs: number, rs: number, fork: number, nL: number, spread: [number, number], seg: number, roughTo = 0) => {
    const ph = r() * Math.PI * 2;
    const lx = Math.cos(a) * Math.tan(lean);
    const lz = Math.sin(a) * Math.tan(lean);
    const at = (y: number): V3 => [foot[0] + lx * y + Math.sin(y * 0.33 + ph) * 0.22 * Math.min(1, y / 3), foot[1] + y, foot[2] + lz * y + Math.cos(y * 0.27 + ph) * 0.18 * Math.min(1, y / 3)];
    const nS = 5;
    const tp: V3[] = [];
    const tr: number[] = [];
    for (let i = 0; i <= nS; i++) {
      tp.push(i === 0 ? [foot[0] - lx * 0.4, foot[1] - 0.3, foot[2] - lz * 0.4] : at((i / nS) * fork));
      tr.push(rs * (i === 0 ? 1.45 : i === 1 ? 1.12 : 1 - (i / nS) * 0.3));
    }
    if (roughTo > 0) {
      // The old bark of the foot: rough, brownish, a separate sleeve up to `roughTo`, the smooth pale stem rising out of it.
      const m = Math.max(2, Math.round((roughTo / fork) * nS));
      k.tube(tp.slice(0, m + 1), tr.slice(0, m + 1).map((q) => q * 1.04), seg, rough, { cell: LEAF_CELL.bark });
      k.tube(tp.slice(m - 1), tr.slice(m - 1), seg, bark, { cell });
    } else k.tube(tp, tr, seg, bark, { cell });
    const T = at(fork);
    for (let l = 0; l < nL; l++) {
      const b = a + (l / nL) * Math.PI * 2 + (r() - 0.5) * 0.8;
      const sp = spread[0] + r() * (spread[1] - spread[0]);
      const dir = norm([Math.cos(b) * sp + lx, 1, Math.sin(b) * sp + lz]);
      const len = ((hs - fork) * (0.82 + r() * 0.16)) / dir[1];
      const mid = add(T, mul(dir, len * 0.5));
      mid[0] += (r() - 0.5) * len * 0.22;
      mid[2] += (r() - 0.5) * len * 0.22;
      const end = add(T, mul(dir, len));
      k.tube([T, mid, end], [rs * 0.62, rs * 0.42, rs * 0.15], Math.max(4, seg - 2), bark, { cell });
      const sb = b + (r() < 0.5 ? -1 : 1) * (0.6 + r() * 0.5);
      const sdir = norm([Math.cos(sb), 0.45 + r() * 0.35, Math.sin(sb)]);
      const slen = crown * (0.5 + r() * 0.3);
      const send = add(mid, mul(sdir, slen));
      send[1] -= slen * 0.12;
      k.tube([mid, add(mix3(mid, send, 0.5), [0, slen * 0.06, 0]), send], [rs * 0.28, rs * 0.17, 0.04], 4, bark, { cell });
      const tw = add(end, [Math.cos(b) * crown * 0.3, -0.3 + r() * 0.8, Math.sin(b) * crown * 0.3]);
      k.tube([end, tw], [rs * 0.13, 0.03], 3, bark, { cell });
      sprays.push(end, send, tw);
    }
  };
  if (v === 0) {
    // The old red gum: thick, low-forked, broad.
    roots(k, r, 5, D.trunk * 1.55, 2.8, rough, LEAF_CELL.bark);
    stem([0, 0, 0], a0, 0.03 + r() * 0.04, h, D.trunk * 1.3, h * (0.3 + r() * 0.05), 4, [0.65, 1.0], 8, 2.6 + r() * 1.4);
  } else if (v === 1) {
    roots(k, r, 4, D.trunk * 1.1, 2.4, bark, cell);
    for (let s = 0; s < 3; s++) {
      const a = a0 + (s / 3) * Math.PI * 2 + (r() - 0.5) * 0.5;
      stem([0, 0, 0], a, 0.15 + r() * 0.1, h * (0.86 + r() * 0.12), D.trunk * 0.6, h * (0.42 + r() * 0.08), 2, [0.38, 0.68], 6);
    }
  } else {
    // The V: a short common bole, then two stems leaning apart.
    roots(k, r, 5, D.trunk * 1.25, 2.4, bark, cell);
    const forkY = 1.3 + r() * 0.8;
    k.tube([[0, -0.3, 0], [0, forkY * 0.5, 0], [0, forkY + 0.3, 0]], [D.trunk * 1.5, D.trunk * 1.2, D.trunk * 1.05], 8, bark, { cell });
    for (const sgn of [0, Math.PI]) {
      const a = a0 + sgn + (r() - 0.5) * 0.3;
      const off: V3 = [Math.cos(a) * D.trunk * 0.35, forkY, Math.sin(a) * D.trunk * 0.35];
      stem(off, a, 0.17 + r() * 0.09, h - forkY, D.trunk * 0.72, (h - forkY) * (0.5 + r() * 0.08), 2, [0.3, 0.6], 6);
    }
  }
  for (const p of sprays) gumSpray(k, r, p, C, R, leaf);
};

const GROW: Record<TreeSpecies, Grow> = { oak, pine, willow, poplar, palm, acacia, cypress, snag, eucalyptus };

const speciesGeos: THREE.BufferGeometry[] = [];

/** All three variants of a species in one geometry (`tree.y` says which variant a vertex belongs to). Built once. */
export function treeGeometry(sp: number): THREE.BufferGeometry {
  const hit = speciesGeos[sp];
  if (hit) return hit;
  const k = new TreeKit();
  for (let v = 0; v < 3; v++) {
    k.variant = v;
    GROW[TREE_SPECIES[sp]](k, rng(sp * 31 + v * 7 + 1), v);
  }
  return (speciesGeos[sp] = k.build());
}

const variantGeos = new Map<number, THREE.BufferGeometry>();
/** Same vertex data and triangle order as the original model, without the other variants' rejected triangles. */
export function treeVariantGeometry(sp: number, variant: number): THREE.BufferGeometry {
  const key = sp * 3 + variant;
  const cached = variantGeos.get(key);
  if (cached) return cached;
  const source = treeGeometry(sp), index = source.index!, tree = source.getAttribute('tree');
  const indices: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    if (tree.getY(index.getX(i)) === variant) indices.push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  }
  const geo = shared(new THREE.BufferGeometry());
  for (const [name, attribute] of Object.entries(source.attributes)) geo.setAttribute(name, attribute);
  geo.setIndex(indices);
  // Retain the existing conservative bounds, including the original model's wind margin.
  geo.boundingBox = source.boundingBox?.clone() ?? null;
  geo.boundingSphere = source.boundingSphere?.clone() ?? null;
  variantGeos.set(key, geo);
  return geo;
}

// ---------------------------------------------------------------------------------------- impostors

/** Width and height of each species' impostor card at scale 1 (the picture fills it). */
const impDims: { w: number; h: number }[] = [];
let impTex: THREE.DataTexture | null = null;

const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const l2s = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);

/**
 * Bake a species' impostor: its first variant drawn orthographically from the side on the CPU (a small z-buffered
 * rasteriser sampling the leaf atlas), so the far trees are pictures of the near ones. Albedo only, with a little light from
 * the leaves' own normals: the impostor shader lights the card with a domed normal on top.
 */
function bakeImpostor(sp: number, atlas: Uint8Array, out: Uint8Array, ox: number, oy: number, stride: number) {
  const g = treeGeometry(sp);
  const P = g.attributes.position.array as Float32Array;
  const Nn = g.attributes.normal.array as Float32Array;
  const U = g.attributes.uv.array as Float32Array;
  const Cc = g.attributes.color.array as Float32Array;
  const T = g.attributes.tree.array as Float32Array;
  const I = g.index!.array;
  let hw = 0;
  let top = 0;
  for (let i = 0; i < P.length / 3; i++) {
    if (T[i * 3 + 1] !== 0) continue;
    hw = Math.max(hw, Math.abs(P[i * 3]), Math.abs(P[i * 3 + 2]));
    top = Math.max(top, P[i * 3 + 1]);
  }
  const N = LEAF_ATLAS.cell;
  const M = 3;
  // The content fills the cell but for a margin of M pixels; the card is sized to match.
  const W = hw * 2 * 1.02 * (N / (N - 2 * M));
  const H = top * 1.01 * (N / (N - M));
  impDims[sp] = { w: W, h: H };
  const X = (x: number) => (x / W + 0.5) * N;
  const Y = (y: number) => (1 - y / H) * N;
  const zb = new Float32Array(N * N).fill(-Infinity);
  const cr = new Float32Array(N * N);
  const cg = new Float32Array(N * N);
  const cb = new Float32Array(N * N);
  const AW = LEAF_ATLAS.w;
  const AH = LEAF_ATLAS.h;
  const lx = 0.3;
  const ly = 0.6;
  const lz = 0.74;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t];
    const b = I[t + 1];
    const c = I[t + 2];
    if (T[a * 3 + 1] !== 0) continue;
    const x0 = X(P[a * 3]);
    const y0 = Y(P[a * 3 + 1]);
    const x1 = X(P[b * 3]);
    const y1 = Y(P[b * 3 + 1]);
    const x2 = X(P[c * 3]);
    const y2 = Y(P[c * 3 + 1]);
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-6) continue;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(N - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(N - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const sx = px + 0.5;
        const sy = py + 0.5;
        const w0 = ((x1 - sx) * (y2 - sy) - (x2 - sx) * (y1 - sy)) / area;
        const w1 = ((x2 - sx) * (y0 - sy) - (x0 - sx) * (y2 - sy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = P[a * 3 + 2] * w0 + P[b * 3 + 2] * w1 + P[c * 3 + 2] * w2;
        const k = py * N + px;
        if (z <= zb[k]) continue;
        const u = U[a * 2] * w0 + U[b * 2] * w1 + U[c * 2] * w2;
        const v = U[a * 2 + 1] * w0 + U[b * 2 + 1] * w1 + U[c * 2 + 1] * w2;
        const j = (Math.min(AH - 1, Math.max(0, Math.floor(v * AH))) * AW + Math.min(AW - 1, Math.max(0, Math.floor(u * AW)))) * 4;
        if (atlas[j + 3] < 128) continue;
        const nx = Nn[a * 3] * w0 + Nn[b * 3] * w1 + Nn[c * 3] * w2;
        const ny = Nn[a * 3 + 1] * w0 + Nn[b * 3 + 1] * w1 + Nn[c * 3 + 1] * w2;
        const nz = Nn[a * 3 + 2] * w0 + Nn[b * 3 + 2] * w1 + Nn[c * 3 + 2] * w2;
        const lit = 0.82 + 0.25 * Math.max(0, (nx * lx + ny * ly + nz * lz) / (Math.hypot(nx, ny, nz) || 1));
        zb[k] = z;
        cr[k] = (Cc[a * 3] * w0 + Cc[b * 3] * w1 + Cc[c * 3] * w2) * S2L[atlas[j]] * lit;
        cg[k] = (Cc[a * 3 + 1] * w0 + Cc[b * 3 + 1] * w1 + Cc[c * 3 + 1] * w2) * S2L[atlas[j + 1]] * lit;
        cb[k] = (Cc[a * 3 + 2] * w0 + Cc[b * 3 + 2] * w1 + Cc[c * 3 + 2] * w2) * S2L[atlas[j + 2]] * lit;
      }
    }
  }
  // Empty texels take the picture's average colour, so filtering never pulls in a fringe.
  let ar = 0;
  let ag = 0;
  let ab = 0;
  let n = 0;
  for (let k = 0; k < N * N; k++) {
    if (zb[k] === -Infinity) continue;
    ar += cr[k];
    ag += cg[k];
    ab += cb[k];
    n++;
  }
  n = Math.max(1, n);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const k = y * N + x;
      const hit = zb[k] !== -Infinity;
      const o = ((oy + y) * stride + ox + x) * 4;
      out[o] = Math.round(Math.min(1, Math.max(0, l2s(hit ? cr[k] : ar / n))) * 255);
      out[o + 1] = Math.round(Math.min(1, Math.max(0, l2s(hit ? cg[k] : ag / n))) * 255);
      out[o + 2] = Math.round(Math.min(1, Math.max(0, l2s(hit ? cb[k] : ab / n))) * 255);
      out[o + 3] = hit ? 255 : 0;
    }
  }
}

/** The impostor atlas (one cell per species, laid out like the leaf atlas). Baked once, on first use. */
export function impostorTexture(): THREE.DataTexture {
  if (impTex) return impTex;
  const { w, h, cols, cell } = LEAF_ATLAS;
  const atlas = leafAtlas().data;
  const data = new Uint8Array(w * h * 4);
  for (let sp = 0; sp < TREE_SPECIES.length; sp++) bakeImpostor(sp, atlas, data, (sp % cols) * cell, Math.floor(sp / cols) * cell, w);
  return (impTex = spriteAtlasTexture(data, w, h, cols, LEAF_ATLAS.rows, 0.5));
}

/** Size of a species' impostor card at scale 1. */
export function impostorDims(sp: number): { w: number; h: number } {
  if (!impDims[sp]) impostorTexture();
  return impDims[sp];
}

let impGeo: THREE.BufferGeometry | null = null;

/** Three vertical cards crossing at 60 degrees, 1 x 1, standing on y = 0. `tang` runs along each card. */
export function impostorGeometry(): THREE.BufferGeometry {
  if (impGeo) return impGeo;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const tang: number[] = [];
  const idx: number[] = [];
  for (let q = 0; q < 3; q++) {
    const a = (q * Math.PI) / 3;
    const tx = Math.cos(a);
    const tz = -Math.sin(a);
    const b = pos.length / 3;
    pos.push(-0.5 * tx, 0, -0.5 * tz, 0.5 * tx, 0, 0.5 * tz, 0.5 * tx, 1, 0.5 * tz, -0.5 * tx, 1, -0.5 * tz);
    uv.push(0, 1, 1, 1, 1, 0, 0, 0);
    for (let i = 0; i < 4; i++) {
      nor.push(-tz, 0, tx);
      tang.push(tx, 0, tz);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('tang', new THREE.Float32BufferAttribute(tang, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return (impGeo = shared(g));
}

// ---------------------------------------------------------------------------------------- materials

/**
 * Per-instance data rides in `instanceColor`: green and blue are the tint, red is the tint plus 4 x the variant (a 3D tree)
 * or the species (an impostor). Float instance colours keep both exactly.
 */
const DECODE = /* glsl */ `
float treeSlot = floor( instanceColor.r * 0.25 + 0.001 );
vec3 treeTint = vec3( instanceColor.r - treeSlot * 4.0, instanceColor.g, instanceColor.b );
`;
const DITHER = /* glsl */ `
float treeDither( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
`;

/**
 * Pale smooth bark (the eucalyptus's) takes a colour of its own per tree: white, cream, salmon-orange, pinkish, grey-brown,
 * from a hash of where the tree stands. Darker barks are left as they are.
 */
const BARK_FN = /* glsl */ `
#ifdef USE_INSTANCING
vec3 barkTint( vec3 c ) {
  vec3 bO = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  float bh = fract( sin( dot( floor( bO.xz * 2.0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  vec3 bt = bh < 0.24 ? vec3( 1.06, 1.06, 1.08 ) : bh < 0.44 ? vec3( 1.02, 0.94, 0.8 ) : bh < 0.64 ? vec3( 1.04, 0.66, 0.46 ) : bh < 0.8 ? vec3( 1.0, 0.8, 0.72 ) : vec3( 0.74, 0.68, 0.62 );
  float pale = smoothstep( 0.22, 0.42, dot( c, vec3( 0.3333 ) ) );
  return mix( vec3( 1.0 ), bt, pale );
}
#endif
`;

function encode(tint: V3, slot: number, out: THREE.Color) {
  return out.setRGB(tint[0] + slot * 4, tint[1], tint[2], THREE.LinearSRGBColorSpace);
}

/**
 * The 3D trees' vertex work: keep only this instance's variant (and, for the colour pass, only near the camera), then sway.
 * Variant indices remove unused models before submission; the guard remains for callers using the complete species geometry.
 * The colour pass also skips trees beyond the cross-fade before lighting. Shadows keep the existing wind and alpha test.
 */
function treeVertex(shader: THREE.WebGLProgramParametersWithUniforms, colour: boolean) {
  shader.uniforms.uTime = GLOBALS.uTime;
  shader.uniforms.uWind = WIND.uWind;
  shader.uniforms.uTreeLod = LOD_U.uTreeLod;
  const keep = /* glsl */ `
#if defined( USE_INSTANCING ) && defined( USE_INSTANCING_COLOR )
{
  ${DECODE}
  vec3 tO = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  ${colour ? 'float tKeep = 1.0 - smoothstep( uTreeLod.x, uTreeLod.y, distance( tO.xz, cameraPosition.xz ) );' : 'float tKeep = 1.0;'}
  if ( abs( tree.y - treeSlot ) > 0.5 || tKeep <= 0.0 ) {
    gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );
    return;
  }
  ${colour ? 'vTreeKeep = tKeep;' : ''}
}
#endif`;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nattribute vec3 tree;\nuniform float uTime;\nuniform vec4 uWind;\nuniform vec2 uTreeLod;\n${colour ? 'varying float vTreeKeep;' : ''}`)
    .replace(colour ? '#include <uv_vertex>' : '#include <project_vertex>', colour ? `${keep}\n#include <uv_vertex>` : `${keep}\n#include <project_vertex>`)
    .replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
#if defined( USE_INSTANCING ) && defined( USE_INSTANCING_COLOR )
{
  vec3 tO = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  float tPh = tO.x * 0.137 + tO.z * 0.091;
  float tS = sin( uTime * 0.83 + tPh ) * 0.65 + sin( uTime * 1.97 + tPh * 1.3 ) * 0.3;
  vec3 tW = transpose( mat3( instanceMatrix ) ) * vec3( uWind.x, 0.0, uWind.z );
  float tY = max( transformed.y, 0.0 );
  transformed += tW * tS * tY * tY * 0.0016 * uWind.w;
  float tF = sin( uTime * 4.7 + tree.z * 6.283 + tPh * 5.0 ) * tree.x * uWind.w;
  transformed += ( normal * 0.05 + vec3( uWind.x, 0.03, uWind.z ) * 0.05 ) * tF;
}
#endif`,
    );
}

let treeMat: THREE.MeshStandardMaterial | null = null;
let treeDepth: THREE.MeshDepthMaterial | null = null;

/** One material for every 3D tree: bark and leaves from the atlas, alpha-tested, both sides, swaying, tinted per tree. */
export function treeMaterial(): THREE.MeshStandardMaterial {
  if (treeMat) return treeMat;
  const m = new THREE.MeshStandardMaterial({ map: leafAtlas().tex, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true, roughness: 0.82, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    treeVertex(shader, true);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${BARK_FN}`);
    shader.vertexShader = shader.vertexShader.replace(
      '#include <color_vertex>',
      `#include <color_vertex>\n#ifdef USE_INSTANCING_COLOR\n{\n${DECODE}\nvColor = vec4( color * ( tree.x > 0.0 ? treeTint : barkTint( color ) ), 1.0 );\n}\n#endif`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vTreeKeep;\n${DITHER}`)
      .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\nif ( treeDither( gl_FragCoord.xy ) >= vTreeKeep ) discard;')
      // Leaf normals were bent round the crown: keep them whichever side of a card faces the camera.
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize( vNormal );');
  };
  m.customProgramCacheKey = () => 'tree3d';
  return (treeMat = shared(m));
}

/** The 3D trees' shadow pass: the same variant pick and sway (three copies the atlas and alpha test in). */
export function treeDepthMaterial(): THREE.MeshDepthMaterial {
  if (treeDepth) return treeDepth;
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (shader) => treeVertex(shader, false);
  m.customProgramCacheKey = () => 'tree3d-depth';
  return (treeDepth = shared(m));
}

export interface LoadedMask {
  tLoaded: { value: THREE.Texture | null };
  uLoadedRect: { value: THREE.Vector4 };
}

function impostorShader(shader: THREE.WebGLProgramParametersWithUniforms, far: LoadedMask | null) {
  shader.uniforms.uTreeLod = LOD_U.uTreeLod;
  if (far) Object.assign(shader.uniforms, far);
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>\nattribute vec3 tang;\nvarying vec3 vImpT;\nvarying vec2 vImpUv;\nvarying float vImpKeep;\nuniform vec2 uTreeLod;\n${far ? 'uniform sampler2D tLoaded;\nuniform vec4 uLoadedRect;' : ''}`,
    )
    .replace('#include <color_vertex>', `#include <color_vertex>\n#ifdef USE_INSTANCING_COLOR\n{\n${DECODE}\nvColor = vec4( treeTint, 1.0 );\n}\n#endif`)
    .replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
#if defined( USE_INSTANCING ) && defined( USE_INSTANCING_COLOR )
{
  ${DECODE}
  vec3 iO = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  ${
    far
      ? `// Inside a loaded chunk the chunk draws its own trees.
  vec2 iLc = ( iO.xz - uLoadedRect.xy ) / uLoadedRect.zw;
  float iKeep = ( iLc.x >= 0.0 && iLc.y >= 0.0 && iLc.x < 1.0 && iLc.y < 1.0 && texture2D( tLoaded, iLc ).r > 0.5 ) ? 0.0 : 1.0;`
      : 'float iKeep = smoothstep( uTreeLod.x, uTreeLod.y, distance( iO.xz, cameraPosition.xz ) );'
  }
  if ( iKeep <= 0.0 ) {
    gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );
    return;
  }
  vImpKeep = iKeep;
  vImpUv = uv;
  #ifdef USE_MAP
    vMapUv = ( vec2( mod( treeSlot, ${LEAF_ATLAS.cols.toFixed(1)} ), floor( treeSlot / ${LEAF_ATLAS.cols.toFixed(1)} + 0.001 ) ) + uv ) * vec2( ${(1 / LEAF_ATLAS.cols).toFixed(6)}, ${(1 / LEAF_ATLAS.rows).toFixed(6)} );
  #endif
  vImpT = normalize( mat3( modelViewMatrix ) * ( mat3( instanceMatrix ) * tang ) );
}
#endif`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vImpT;\nvarying vec2 vImpUv;\nvarying float vImpKeep;\n${DITHER}`)
    .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\nif ( treeDither( gl_FragCoord.xy ) < 1.0 - vImpKeep ) discard;')
    .replace(
      '#include <normal_fragment_begin>',
      /* glsl */ `#include <normal_fragment_begin>
{
  // A dome over the card: out to the sides along it, up toward the top, and toward whoever looks at it.
  vec3 iF = normalize( vNormal ) * faceDirection;
  vec3 iU = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float ix = ( vImpUv.x - 0.5 ) * 2.0;
  float iy = ( 0.62 - vImpUv.y ) * 2.0;
  normal = normalize( normalize( vImpT ) * ix * 0.85 + iU * ( iy * 0.6 + 0.35 ) + iF * 0.75 );
}`,
    );
}

let impNear: THREE.MeshStandardMaterial | null = null;

function impostorBase(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map: impostorTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
}

/** Impostors of a chunk's own trees: they fade in where the 3D trees fade out. */
export function impostorMaterial(): THREE.MeshStandardMaterial {
  if (impNear) return impNear;
  const m = impostorBase();
  m.onBeforeCompile = (shader) => impostorShader(shader, null);
  m.customProgramCacheKey = () => 'tree-imp';
  return (impNear = shared(m));
}

/** Impostors of the far forest: hidden wherever the landscape's mask says a chunk is loaded. One per landscape. */
export function farForestMaterial(mask: LoadedMask): THREE.MeshStandardMaterial {
  const m = impostorBase();
  m.onBeforeCompile = (shader) => impostorShader(shader, mask);
  m.customProgramCacheKey = () => 'tree-far';
  return m;
}

// ---------------------------------------------------------------------------------------- per chunk

export interface TreeInstance {
  sp: number;
  v: number;
  /** Column-major world matrix of the 3D tree. */
  m: number[];
  tint: V3;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/** A tree's leaf tint: a little yellower, bluer, lighter or darker than its neighbours. */
function tintOf(x: number, z: number): V3 {
  const k1 = hash2(Math.round(x * 10), Math.round(z * 10), 911);
  const k2 = hash2(Math.round(x * 10), Math.round(z * 10), 912);
  const l = 0.88 + k2 * 0.24;
  return [l * (0.94 + k1 * 0.14), l, l * (1.02 - k1 * 0.12)];
}

/**
 * A tree's own proportions: its crown a little wider or narrower, the tree a little taller or squatter than the model, so
 * neighbours of one variant do not look stamped out. Eucalyptus vary most.
 */
export function treeAspect(t: TreeSpot): [number, number] {
  if (t.aspect) return t.aspect;
  const k1 = hash2(Math.round(t.x * 10), Math.round(t.z * 10), 913);
  const k2 = hash2(Math.round(t.x * 10), Math.round(t.z * 10), 914);
  const gum = TREE_SPECIES[t.sp] === 'eucalyptus';
  return [1 + (k1 - 0.5) * (gum ? 0.42 : 0.2), 1 + (k2 - 0.5) * (gum ? 0.26 : 0.16)];
}

/** How a chunk's trees are drawn: pure and deterministic, one entry per `TreeSpot`. */
export function treeInstances(trees: TreeSpot[]): TreeInstance[] {
  return trees.map((t) => {
    _p.set(t.x, t.y, t.z);
    _e.set(t.lean[0], t.yaw, t.lean[1], 'YXZ');
    _q.setFromEuler(_e);
    const [ax, ay] = treeAspect(t);
    _s.set(t.s * ax, t.s * ay, t.s * ax);
    _m.compose(_p, _q, _s);
    return { sp: t.sp, v: t.v, m: _m.toArray(), tint: tintOf(t.x, t.z) };
  });
}

export interface TreeSet {
  /** The 3D trees, one mesh per species/variant present; vertex buffers remain shared. */
  near: THREE.InstancedMesh[];
  /** Every tree of the chunk as an impostor, for whoever is further away. */
  far: THREE.InstancedMesh | null;
}

/** A chunk's trees in slices: a species/variant a slice. */
export function* buildTreesSteps(trees: TreeSpot[]): Generator<void, TreeSet> {
  const set: TreeSet = { near: [], far: null };
  if (!trees.length) return set;
  const inst = treeInstances(trees);
  for (let sp = 0; sp < TREE_SPECIES.length; sp++) {
    for (let variant = 0; variant < 3; variant++) {
      const mine = inst.filter((t) => t.sp === sp && t.v === variant);
      if (!mine.length) continue;
      const im = new THREE.InstancedMesh(treeVariantGeometry(sp, variant), treeMaterial(), mine.length);
      im.userData.sp = sp;
      im.userData.variant = variant;
      mine.forEach((t, i) => {
        im.setMatrixAt(i, _m.fromArray(t.m));
        im.setColorAt(i, encode(t.tint, t.v, _c));
      });
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor!.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = true;
      im.receiveShadow = true;
      im.customDepthMaterial = treeDepthMaterial();
      set.near.push(im);
      yield;
    }
  }
  const im = new THREE.InstancedMesh(impostorGeometry(), impostorMaterial(), trees.length);
  trees.forEach((t, i) => {
    const d = impostorDims(t.sp);
    const [ax, ay] = treeAspect(t);
    _p.set(t.x, t.y + 0.1, t.z);
    _q.setFromAxisAngle(UP, t.yaw);
    _s.set(d.w * t.s * ax, d.h * t.s * ay, d.w * t.s * ax);
    im.setMatrixAt(i, _m.compose(_p, _q, _s));
    im.setColorAt(i, encode(inst[i].tint, t.sp, _c));
  });
  im.instanceMatrix.needsUpdate = true;
  im.instanceColor!.needsUpdate = true;
  im.computeBoundingSphere();
  set.far = im;
  return set;
}

/** Distance within which a chunk's 3D trees can be seen at all (the views cross-fade to impostors before it). */
export const TREE_NEAR_SHOW = TREE_LOD.far + 15;

// ---------------------------------------------------------------------------------------- far forest

export interface FarTree {
  x: number;
  y: number;
  z: number;
  sp: number;
  s: number;
  yaw: number;
}

/** Spacing of the far forest's planting grid (metres), and the side of its regions (one draw each). */
const FAR_STEP = 9;
const FAR_REGION = 512;

/**
 * The far forest of an open-world leg: the woods of `world/flora.ts` again, on a coarse jittered grid with bigger trees,
 * by the same rules (lush land, woods in clumps, lone trees in the meadows and acacias in the dry grass; clear of roads,
 * water, places, crossings and steep ground; which species by where). `ground` is the height to stand them on (the far
 * landscape mesh), `slope` its steepness. Grouped by region, in a fixed order. Pure and deterministic.
 */
export function planFarForest(def: TerrainDef, ground: (x: number, z: number) => number, slope: (x: number, z: number) => number): FarTree[][] {
  const hy = def.hydro;
  const o = def.open;
  if (!hy?.lush || !o) return [];
  const seed = def.seed * 17 + 113;
  const G = FAR_STEP;
  // Places by 256 m cell, so each tree asks only its neighbours.
  const B = 256;
  const bucket = new Map<number, { x: number; z: number; r: number }[]>();
  const bkey = (ix: number, iz: number) => (ix + 512) * 1024 + (iz + 512);
  for (const s of def.sites) {
    const r = s.radius > 0 ? s.radius * 0.95 + 4 : 16;
    for (let ix = Math.floor((s.x - r) / B); ix <= Math.floor((s.x + r) / B); ix++) {
      for (let iz = Math.floor((s.z - r) / B); iz <= Math.floor((s.z + r) / B); iz++) {
        const k = bkey(ix, iz);
        let l = bucket.get(k);
        if (!l) bucket.set(k, (l = []));
        l.push({ x: s.x, z: s.z, r });
      }
    }
  }
  const regions = new Map<number, FarTree[]>();
  const nx = Math.ceil((o.x1 - o.x0) / G);
  const nz = Math.ceil((o.z1 - o.z0) / G);
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = o.x0 + (ix + 0.2 + hash2(ix, iz, seed) * 0.6) * G;
      const z = o.z0 + (iz + 0.2 + hash2(ix, iz, seed + 1) * 0.6) * G;
      const L = lushAt(def, x, z);
      if (L < 0.22) continue;
      const pLone = L > 0.4 ? 0.05 * L : 0;
      const pAcacia = L < 0.55 ? 0.04 * smoothstep(0.22, 0.38, L) : 0;
      const roll = hash2(ix, iz, seed + 2);
      // Woods only grow where `forestAt` can be above 0 (lush past 0.42): ask it only there.
      if (roll > pLone + pAcacia + (L < 0.42 ? 0 : 1)) continue;
      const F = L < 0.42 ? 0 : forestAt(def, x, z);
      const pWood = F;
      if (roll > pWood + pLone + pAcacia) continue;
      const rd = nearestRoad(o, x, z);
      if (rd.road && rd.edge < (rd.road.kind === 'highway' ? 9 : rd.road.kind === 'road' ? 6 : 3.5)) continue;
      if (slope(x, z) > 0.6) continue;
      let wet = false;
      for (const l of def.lakes) if (lakeQ(l, x, z) < 1.04) wet = true;
      if (wet) continue;
      const c = courseAt(hy, x, z);
      if (c && c.d < c.half + 2.2) continue;
      const y = ground(x, z);
      let swamp = false;
      for (const s of hy.swamps) {
        const q = swampQ(s, x, z);
        if (q < 1.15) swamp = true;
        if (q < 1 && y < s.level - 0.45) wet = true;
      }
      if (wet) continue;
      let oasis = false;
      let spring = false;
      for (const s of hy.springs) {
        const d = Math.hypot(x - s.x, z - s.z);
        if (d < s.r + 2.5) spring = true;
        if (s.oasis && d < s.r + 38) oasis = true;
      }
      if (spring) continue;
      if (bucket.get(bkey(Math.floor(x / B), Math.floor(z / B)))?.some((s) => Math.hypot(x - s.x, z - s.z) < s.r)) continue;
      if (hy.crossings.some((q) => Math.hypot(x - q.x, z - q.z) < q.span * 0.5 + q.roadHalf + 16)) continue;
      if (heritageClear(def.heritage, x, z, 3)) continue;
      if (bendClear(def, x, z)) continue;
      const k = hash2(ix, iz, seed + 3);
      const woods = woodsAt(def, x, z);
      let sp: TreeSpecies;
      if (oasis) sp = 'palm';
      else if (swamp) sp = woodSpecies('fen', k, L, F);
      else if (woods === 'fen' || woods === 'riparian' || woods === 'gum') sp = woodSpecies(woods, k, L, F);
      else if (roll > pWood + pLone) sp = 'acacia';
      else sp = woodSpecies(woods, k, L, F);
      const key = Math.floor((x - o.x0) / FAR_REGION) * 1000 + Math.floor((z - o.z0) / FAR_REGION);
      let list = regions.get(key);
      if (!list) regions.set(key, (list = []));
      list.push({ x, y, z, sp: TREE_SPECIES.indexOf(sp), s: (0.72 + hash2(ix, iz, seed + 5) * 0.55) * 1.2, yaw: hash2(ix, iz, seed + 4) * Math.PI * 2 });
    }
  }
  // The old gums of the rivers' bends, set by hand: seen from afar like any other gum.
  for (const t of bendStems(def, o.x0, o.z0, o.x1, o.z1)) {
    const key = Math.floor((t.x - o.x0) / FAR_REGION) * 1000 + Math.floor((t.z - o.z0) / FAR_REGION);
    let list = regions.get(key);
    if (!list) regions.set(key, (list = []));
    list.push({ x: t.x, y: ground(t.x, t.z), z: t.z, sp: t.sp, s: t.s * 1.2, yaw: t.yaw });
  }
  return [...regions.values()];
}

/** One impostor mesh per region of the far forest. */
export function farForestMeshes(groups: FarTree[][], mat: THREE.Material): THREE.InstancedMesh[] {
  return groups.map((list) => {
    const im = new THREE.InstancedMesh(impostorGeometry(), mat, list.length);
    list.forEach((t, i) => {
      const d = impostorDims(t.sp);
      _p.set(t.x, t.y, t.z);
      _q.setFromAxisAngle(UP, t.yaw);
      _s.set(d.w * t.s, d.h * t.s, d.w * t.s);
      im.setMatrixAt(i, _m.compose(_p, _q, _s));
      im.setColorAt(i, encode(tintOf(t.x, t.z), t.sp, _c));
    });
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor!.needsUpdate = true;
    im.computeBoundingSphere();
    return im;
  });
}

/**
 * Meshes that draw nothing but make the renderer compile the tree programs (and the trees' shadow program) with the
 * landscape, at load, instead of with the first wood streamed in.
 */
export function treeWarmup(): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  for (const [geo, mat] of [[treeGeometry(0), treeMaterial()], [impostorGeometry(), impostorMaterial()]] as const) {
    const im = new THREE.InstancedMesh(geo, mat, 1);
    im.setMatrixAt(0, _m.makeScale(0, 0, 0));
    im.setColorAt(0, _c.setRGB(1, 1, 1));
    im.frustumCulled = false;
    im.castShadow = mat === treeMat;
    im.customDepthMaterial = treeDepthMaterial();
    // Drawn once (the shadow pass comes first), then put away.
    im.onAfterRender = () => {
      im.visible = false;
    };
    out.push(im);
  }
  return out;
}

/** Scorched leaves go brown first, then the whole tree black. */
const SCORCH: V3 = [0.32, 0.2, 0.09];
const CHAR: V3 = [0.06, 0.05, 0.045];

/**
 * Darken one tree of a chunk's set to how far fire has charred it (0 green, 1 a black snag), in both its 3D mesh and its
 * impostor. `idx` is its index in the chunk's tree list (the order `buildTreesSteps` was given).
 */
export function charTreeInstance(set: TreeSet, trees: TreeSpot[], idx: number, char: number) {
  const t = trees[idx];
  if (!t) return;
  const base = tintOf(t.x, t.z);
  const k = Math.min(1, Math.max(0, char));
  const tint = k < 0.4 ? mix3(base, SCORCH, k / 0.4) : mix3(SCORCH, CHAR, (k - 0.4) / 0.6);
  let n = 0;
  for (let i = 0; i < idx; i++) if (trees[i].sp === t.sp && trees[i].v === t.v) n++;
  const im = set.near.find((m) => m.userData.sp === t.sp && m.userData.variant === t.v);
  if (im?.instanceColor) {
    im.setColorAt(n, encode(tint, t.v, _c));
    im.instanceColor.addUpdateRange(n * 3, 3);
    im.instanceColor.needsUpdate = true;
  }
  if (set.far?.instanceColor) {
    set.far.setColorAt(idx, encode(tint, t.sp, _c));
    set.far.instanceColor.addUpdateRange(idx * 3, 3);
    set.far.instanceColor.needsUpdate = true;
  }
}
