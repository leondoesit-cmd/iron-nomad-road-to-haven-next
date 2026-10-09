import * as THREE from 'three';
import { GLOBALS } from './materials';
import { FAR_CUT_FRAG, FAR_CUT_FRAG_PARS } from './dissolve';
import { BARK, BARK_DEPTH, BARK_ROUGH, BARK_SIZE, BARK_TILE, barkStats, barkTextures } from './barkTex';
import { shared } from './dispose';
import { LEAF_ATLAS, LEAF_CELL, leafAtlas, spriteAtlasTexture } from './proctex';
import { WIND_GLSL, windUniforms } from './wind';
import { hash2 } from '../core/rng';
import { TREE_MECHANICS } from '../sim/vegetation';
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

// ---------------------------------------------------------------------------------------- the wind in a tree

/** A tube of wood or a strip of foliage as the kit laid it: its vertices (`rows` of `per` from `base`) and centre line. */
interface KitPiece {
  leaf: boolean;
  variant: number;
  base: number;
  rows: number;
  per: number;
  pts: V3[];
  rad?: number[];
  /** A strip's most flutter, as its species code gave it. */
  loose?: number;
  /** Shed bark hanging off a limb: it rides its wood, but nothing grows from it. */
  ribbon?: boolean;
}

/**
 * How each species' leaves take the wind: how quickly they flutter (Hz) and how loosely they hang. A poplar's flat stalks
 * shiver, pine needles barely stir, palm fronds and willow strands swing slowly and far.
 */
const LEAF_WIND: Record<TreeSpecies, { hz: number; loose: number }> = {
  oak: { hz: 2.6, loose: 1 },
  pine: { hz: 1.7, loose: 0.5 },
  willow: { hz: 0.9, loose: 1.1 },
  poplar: { hz: 4.2, loose: 1.25 },
  palm: { hz: 0.7, loose: 0.75 },
  acacia: { hz: 2.2, loose: 0.7 },
  cypress: { hz: 1.5, loose: 0.75 },
  snag: { hz: 1.0, loose: 0.9 },
  eucalyptus: { hz: 1.6, loose: 1 },
};

/**
 * How each species stands in the wind: the height its trunk bends over (m), how far its top goes (m) at a trunk drive of 1
 * (a gale), how quickly it sways (Hz: the spring a car bends it with, `TREE_MECHANICS`) and how quickly its leaves flutter.
 * A trunk is a cantilever with the crown for its sail and the stem's section (d^4) for its stiffness. Trees grow into their
 * load, so the raw ratio is softened (^0.4): slender poplars, pines and gums still sway several times further than a stout
 * oak or willow, and a leafless snag has little sail.
 */
const TREE_WIND = TREE_SPECIES.map((sp) => {
  const d = TREE_DIMS[sp];
  const sail = 2 * d.crown * Math.max(1, d.h - d.bole) * (sp === 'snag' ? 0.25 : 1);
  const slender = (sail * d.h * d.h) / (2 * d.trunk) ** 4;
  return { h: d.h, lean: 0.0055 * slender ** 0.4 * (d.h / 10), hz: TREE_MECHANICS[sp].frequency / (2 * Math.PI), leaf: LEAF_WIND[sp].hz };
});

const frac = (x: number) => x - Math.floor(x);
const q6 = (x: number) => Math.min(63, Math.floor(frac(x) * 64));
/** Three phases (0..1, in 64 steps) and the species, in one float that holds them exactly. */
const packPhases = (p1: number, p2: number, pl: number, sp: number) => q6(p1) + 64 * q6(p2) + 4096 * q6(pl) + 262144 * sp;
/** A limb's and a twig's give (m, in mm up to 4.095 m), in one float that holds them exactly. */
const packFlex = (f1: number, f2: number) => Math.min(4095, Math.round(f1 * 1000)) + 4096 * Math.min(4095, Math.round(f2 * 1000));
/** A unit axis, octahedral (folded about y), 12 bits a side, in one float. */
function packAxis(a: V3): number {
  const l1 = Math.abs(a[0]) + Math.abs(a[1]) + Math.abs(a[2]) || 1;
  let u = a[0] / l1;
  let v = a[2] / l1;
  if (a[1] < 0) [u, v] = [(1 - Math.abs(v)) * (u < 0 ? -1 : 1), (1 - Math.abs(u)) * (v < 0 ? -1 : 1)];
  return Math.round((u * 0.5 + 0.5) * 4095) + 4096 * Math.round((v * 0.5 + 0.5) * 4095);
}
/** Which way a piece grows, as a phase: pieces growing alike move alike, each other angle at its own time. */
const growPhase = (d: V3) => frac(Math.atan2(d[2], d[0]) / Math.PI + d[1] * 0.45);

/**
 * The wind data of every vertex of a kit. Wood: each tube finds the piece it grows from (the nearest point of the wood laid
 * before it); a tube off the trunk is a limb, anything further out a twig, and a tube that reaches the ground (the trunk, a
 * root, a knee) stays put. Each gives more toward its tip, the more the longer and thinner it is, and swings at its own time,
 * set by the way it grows; its foot rides the piece it grows from, so nothing comes apart. Leaves: each hangs from its end
 * nearer the wood (a strip from its first point), rides that wood, and turns about that point at the time the angle it grows
 * at gives it.
 *
 * `tree`: x how loosely it hangs (0 for wood), y the variant, z the phases and species (`packPhases`), w the limb's and the
 * twig's give there (`packFlex`). `aLeaf`: the point a leaf hangs from (xyz) and the axis it grows along (w, `packAxis`).
 */
function treeWindData(k: TreeKit): { tree: Float32Array; leaf: Float32Array } {
  const n = k.pos.length / 3;
  const tree = new Float32Array(n * 4);
  const leaf = new Float32Array(n * 4);
  const still = packPhases(0, 0, 0, k.sp);
  for (let i = 0; i < n; i++) {
    tree[i * 4 + 1] = k.tree[i * 3 + 1];
    tree[i * 4 + 2] = still;
  }
  interface Wood { pc: KitPiece; level: number; f1: number[]; f2: number[]; p1: number; p2: number }
  const woods: Wood[] = [];
  /** The nearest point of the wood laid so far (of one variant): which piece, how far, and its give there. */
  const nearest = (p: V3, variant: number) => {
    let best: { w: Wood | null; d: number; f1: number; f2: number } = { w: null, d: Infinity, f1: 0, f2: 0 };
    for (const w of woods) {
      if (w.pc.variant !== variant || w.pc.ribbon) continue;
      const P = w.pc.pts;
      for (let i = 0; i < P.length - 1; i++) {
        const ab = sub(P[i + 1], P[i]);
        const t = Math.min(1, Math.max(0, dot(sub(p, P[i]), ab) / Math.max(1e-6, dot(ab, ab))));
        const d = Math.hypot(...sub(p, add(P[i], mul(ab, t))));
        if (d < best.d) best = { w, d, f1: w.f1[i] + (w.f1[i + 1] - w.f1[i]) * t, f2: w.f2[i] + (w.f2[i + 1] - w.f2[i]) * t };
      }
    }
    return best;
  };
  for (const pc of k.pieces) {
    if (pc.leaf) continue;
    const P = pc.pts;
    const s = [0];
    for (let i = 1; i < P.length; i++) s.push(s[i - 1] + Math.hypot(...sub(P[i], P[i - 1])));
    const L = Math.max(1e-3, s[s.length - 1]);
    const own = growPhase(norm(sub(P[P.length - 1], P[0])));
    const zero = s.map(() => 0);
    const at = !pc.ribbon && Math.min(...P.map((p) => p[1])) < 0.3 ? null : nearest(P[0], pc.variant);
    let w: Wood;
    if (!at?.w) w = { pc, level: 0, f1: zero, f2: zero, p1: own, p2: own };
    else {
      const from = at.w;
      const rMean = pc.rad!.reduce((a, b) => a + b, 0) / pc.rad!.length;
      const limb = from.level === 0;
      const give = limb ? 0.15 * L * Math.min(2, Math.max(0.3, 0.12 / rMean)) : 0.12 * L * Math.min(2, Math.max(0.3, 0.05 / rMean));
      const grow = s.map((x) => give * (x / L) ** 1.5);
      w = limb
        ? { pc, level: 1, f1: grow, f2: zero, p1: own, p2: own }
        : { pc, level: 2, f1: s.map(() => at.f1), f2: grow.map((g) => at.f2 + g), p1: from.p1, p2: from.level === 1 ? own : from.p2 };
    }
    woods.push(w);
    for (let r = 0; r < pc.rows; r++) {
      const ph = packPhases(w.p1, w.p2, 0, k.sp);
      const fl = packFlex(w.f1[r], w.f2[r]);
      for (let j = 0; j < pc.per; j++) {
        const v = (pc.base + r * pc.per + j) * 4;
        tree[v + 2] = ph;
        tree[v + 3] = fl;
      }
    }
  }
  const lw = LEAF_WIND[TREE_SPECIES[k.sp]];
  for (const pc of k.pieces) {
    if (!pc.leaf) continue;
    const P = pc.pts;
    let hinge = P[0];
    let tip = P[P.length - 1];
    let at = nearest(hinge, pc.variant);
    if (P.length === 2) {
      // A card hangs from whichever end is nearer its wood (between equals, the one nearer the trunk and lower down).
      const other = nearest(tip, pc.variant);
      const score = (p: V3, a: { d: number }) => a.d + 0.25 * Math.hypot(p[0], p[2]) + 0.05 * p[1];
      if (score(tip, other) < score(hinge, at)) [hinge, tip, at] = [tip, hinge, other];
    }
    const ax = norm(sub(tip, hinge));
    const pl = growPhase(ax);
    // A leaf well away from any drawn wood hangs on a twig nobody drew, and has that twig's give.
    const twig = Math.max(0, at.d - 0.3) * 0.1;
    const ph = packPhases(at.w?.p1 ?? 0, at.w && at.w.level > 0 ? at.w.p2 : pl, pl, k.sp);
    const fl = packFlex(at.f1, at.f2 + twig);
    const loose = lw.loose * Math.min(1, Math.max(0.4, pc.loose ?? 1));
    const pa = packAxis(ax);
    for (let r = 0; r < pc.rows * pc.per; r++) {
      const v = (pc.base + r) * 4;
      tree[v] = loose;
      tree[v + 2] = ph;
      tree[v + 3] = fl;
      leaf[v] = hinge[0];
      leaf[v + 1] = hinge[1];
      leaf[v + 2] = hinge[2];
      leaf[v + 3] = pa;
    }
  }
  return { tree, leaf };
}

// ---------------------------------------------------------------------------------------- the kit

/**
 * Accumulates one species' geometry: tubes for wood and strips of cards for foliage. Every vertex carries `tree` (`kit.tree`
 * here: how much it flutters, 0 for wood; which variant it belongs to; a flutter phase), which `build` turns into the wind
 * data (`treeWindData`).
 */
class TreeKit {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  tree: number[] = [];
  /** Per vertex: the bark's (u, v) in tiles of its layer, the layer, and the rough layer + how far it covers (leaves: layer -1). */
  bark: number[] = [];
  idx: number[] = [];
  variant = 0;
  /** The species' bark layer (`BARK`), for every tube not told otherwise. */
  barkLayer: number = BARK.furrow;
  private woodN = 0;
  /** Convex pieces of the actual wood rings, for a fallen tree's compound rigid body. */
  woodHulls: { variant: number; vertices: Float32Array }[] = [];
  /** Which species this is (its index in TREE_SPECIES), for the wind. */
  sp = 0;
  /** Every tube and strip as laid, for the wind (`treeWindData`). */
  pieces: KitPiece[] = [];

  /** A stable random number for the next piece of wood (where its bark starts). */
  private nextRand(): number {
    const x = Math.sin(++this.woodN * 12.9898 + this.variant * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  private rgb(hex: number, k: number): V3 {
    _col.setHex(hex);
    return [_col.r * k, _col.g * k, _col.b * k];
  }

  /**
   * A tapered tube through `pts` with radius `rad[i]` at each point and `seg` sides, wrapped in bark: `bark` (the species'
   * layer unless told otherwise) at its true size, a whole number of tiles round (so the seam never shows) and as many up it
   * as keep the bark's grain square, its scale following the girth as real bark's does; a twig too thin for one tile round
   * takes it mirrored at full size rather than squeezed. `rough` (0..1 per ring) fades in the layer's rough partner
   * (`BARK_ROUGH`, a gum's rough foot). `cell` is the atlas bark the impostors are baked from. `flute` ripples the radius
   * round the ring (a buttressed foot), `ring` shades a ring (a palm's leaf scars). Darker at the foot. `hull: false` keeps
   * a small piece (a burl, a stub) out of a fallen tree's rigid body.
   */
  tube(
    pts: V3[],
    rad: number[],
    seg: number,
    hex: number,
    o: { flute?: (i: number, a: number) => number; ring?: (i: number) => number; cell?: number; bark?: number; rough?: (i: number) => number; hull?: boolean } = {},
  ) {
    if (pts.length === 2 && rad[0] > 0.06 && rad[0] > rad[1] * 2.5 && !o.flute && !o.ring && !o.rough) {
      // A short piece tapering hard (a bough, a root wedge, a knee) gets a ring halfway, so its bark stays square at both ends.
      pts = [pts[0], mix3(pts[0], pts[1], 0.5), pts[1]];
      rad = [rad[0], (rad[0] + rad[1]) / 2, rad[1]];
    }
    const n = pts.length;
    const { u0, u1, v0, v1 } = cellUv(o.cell ?? LEAF_CELL.bark);
    const L = [0];
    for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(...sub(pts[i], pts[i - 1])));
    const layer = o.bark ?? this.barkLayer;
    const tile = BARK_TILE[layer];
    const roughL = o.rough ? BARK_ROUGH[layer]?.layer ?? -1 : -1;
    // The girth the bark is sized to: the tube's mean, leaning on its low stretch, where it is seen from close by.
    let girth = 0;
    let weight = 0;
    for (let i = 0; i < n - 1; i++) {
      const w = (L[i + 1] - L[i]) / (1 + Math.max(0, (pts[i][1] + pts[i + 1][1]) / 2 - 2) / 3);
      girth += Math.PI * (rad[i] + rad[i + 1]) * w;
      weight += w;
    }
    girth /= Math.max(1e-3, weight);
    const round = Math.round(girth / tile);
    const mirror = round < 1;
    const tileAt = (i: number) => (mirror ? tile : Math.min(tile * 2, Math.max(tile * 0.25, (Math.PI * 2 * rad[i]) / round)));
    const bu = this.nextRand();
    const bv = [this.nextRand() * 8];
    for (let i = 1; i < n; i++) bv.push(bv[i - 1] + ((L[i] - L[i - 1]) * 2) / (tileAt(i - 1) + tileAt(i)));
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
      const bw = roughL >= 0 ? roughL + Math.min(1, Math.max(0, o.rough!(i))) * 0.99 : 0;
      const around = mirror ? (Math.PI * rad[i]) / tile : round;
      const ring: V3[] = [];
      const dirs: V3[] = [];
      const arc = [0];
      for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const d = add(mul(N, Math.cos(a)), mul(B, Math.sin(a)));
        ring.push(add(pts[i], mul(d, rad[i] * (o.flute ? o.flute(i, a) : 1))));
        dirs.push(d);
        if (j > 0) arc.push(arc[j - 1] + Math.hypot(...sub(ring[j], ring[j - 1])));
      }
      for (let j = 0; j <= seg; j++) {
        // Round the ring by its true length, so a fluted foot's bark does not bunch in the hollows and spread on the ribs.
        const f = arc[j] / (arc[seg] || 1);
        this.pos.push(...ring[j]);
        this.nor.push(...dirs[j]);
        this.uv.push(u0 + ((u1 - u0) * j) / seg, vv);
        this.col.push(...c);
        this.tree.push(0, this.variant, 0);
        this.bark.push(bu + around * (mirror ? 1 - Math.abs(1 - 2 * f) : f), bv[i], layer, bw);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      if (o.hull !== false) this.woodHulls.push({ variant: this.variant, vertices: Float32Array.from(this.pos.slice((base + i * (seg + 1)) * 3, (base + (i + 2) * (seg + 1)) * 3)) });
      for (let j = 0; j < seg; j++) {
        const a = base + i * (seg + 1) + j;
        const b = a + 1;
        const c = a + seg + 1;
        const d = c + 1;
        this.idx.push(a, b, c, b, d, c);
      }
    }
    this.pieces.push({ leaf: false, variant: this.variant, base, rows: n, per: seg + 1, pts: pts.map((p): V3 => [p[0], p[1], p[2]]), rad: rad.slice() });
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
        this.bark.push(0, 0, -1, 0);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    this.pieces.push({ leaf: true, variant: this.variant, base, rows: n, per: 2, pts: pts.map((p): V3 => [p[0], p[1], p[2]]), loose: Math.max(...flutter) });
  }

  /** One card centred at `c`: `w` wide along `right`, `h` tall along `up` (the top of the picture toward +up). */
  card(c: V3, right: V3, up: V3, w: number, h: number, cell: number, hex: number, tone: number, flutter: number, C: V3, R: V3, phase: number) {
    this.strip([add(c, mul(up, h / 2)), add(c, mul(up, -h / 2))], [right, right], [w / 2, w / 2], cell, 'v', hex, tone, [flutter, flutter * 0.6], C, R, phase);
  }

  /**
   * A ribbon of shed bark hanging along `pts`, `hw[i]` either side along `side[i]`: thin wood, seen from both sides, in bark
   * layer `layer` at its true size. Not part of a fallen tree's rigid body.
   */
  ribbon(pts: V3[], side: V3[], hw: number[], hex: number, layer: number, cell: number) {
    const n = pts.length;
    const { u0, u1, v0, v1 } = cellUv(cell);
    const tile = BARK_TILE[layer];
    const bu = this.nextRand();
    let bv = this.nextRand() * 8;
    const base = this.pos.length / 3;
    for (let i = 0; i < n; i++) {
      if (i > 0) bv += Math.hypot(...sub(pts[i], pts[i - 1])) / tile;
      const tg = norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]));
      const face = norm(cross(side[i], tg));
      const c = this.rgb(hex, 0.62 + 0.38 * Math.min(1, Math.max(0, pts[i][1]) / 1.8));
      for (const s of [-1, 1]) {
        this.pos.push(...add(pts[i], mul(side[i], hw[i] * s)));
        this.nor.push(...face);
        this.uv.push(s < 0 ? u0 : u1, v0 + ((v1 - v0) * i) / (n - 1));
        this.col.push(...c);
        this.tree.push(0, this.variant, 0);
        this.bark.push(bu + ((s + 1) * hw[i]) / tile, bv, layer, 0);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    // In the wind a ribbon is thin wood off its limb: it rides the limb and swings a little further, like a twig.
    this.pieces.push({ leaf: false, variant: this.variant, base, rows: n, per: 2, pts: pts.map((p): V3 => [p[0], p[1], p[2]]), rad: hw.map(() => 0.02), ribbon: true });
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    const wind = treeWindData(this);
    g.setAttribute('tree', new THREE.Float32BufferAttribute(wind.tree, 4));
    g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(wind.leaf, 4));
    g.setAttribute('bark', new THREE.Float32BufferAttribute(this.bark, 4));
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
function roots(k: TreeKit, r: () => number, n: number, rb: number, reach: number, hex: number, o: Parameters<TreeKit['tube']>[4] = {}) {
  const a0 = r() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + (r() - 0.5) * 0.7;
    const L = reach * (0.65 + r() * 0.55);
    const c = Math.cos(a);
    const s = Math.sin(a);
    const at = (d: number, y: number): V3 => [c * d, y, s * d];
    k.tube([at(rb * 0.45, 0.55), at(rb + L * 0.22, 0.2 + r() * 0.12), at(rb + L * 0.6, 0.04 + r() * 0.06), at(rb + L, -0.6)], [rb * 0.42, rb * 0.3, rb * 0.17, 0.03], 4, hex, o);
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
  // Smooth and pale up the stem, fissured at the foot.
  const footTo = 1.2 + r() * 1.6;
  k.tube(tp, tr, 7, bark, { rough: (i) => 1 - smoothstep(footTo * 0.3, footTo, tp[i][1]) });
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
  k.tube(pts, rad, 8, bark, { ring: (i) => (i % 2 ? 0.9 : 1), cell: LEAF_CELL.palmBark });
  const top = P(1);
  k.tube([add(top, [0, -0.5, 0]), add(top, [0, 0.35, 0]), add(top, [0, 0.8, 0])], [0.34, 0.36, 0.16], 8, 0x7a5f3e, { bark: BARK.fibre });
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
 * a massive short bole, its old bark rough and grey-brown to a few metres up and breaking up into flakes above that, parting
 * low into four great sinuous pale limbs that sweep out into a broad, open, weeping crown. Variant 1 is the many-stemmed
 * clump. Variant 2 is the V: a short bole forking at head height into two tall stems leaning apart, smooth-barked and
 * shedding. The leaves hang in loose drooping sprays at the twig ends, an open crown with the sky through it. The bark is one
 * bark from the roots to the twigs (`BARK.gum`, fading into `BARK.gumRough` at the foot), and the things bark does that a
 * texture should not be stretched to fake are parts of their own: ribbons of shed bark hanging from the forks and limbs,
 * dead stubs where small limbs broke off. Each tree's bark takes its own colour, patches and placing in
 * the shader (white, cream, salmon, grey-brown), so the same shape never looks twice the same.
 */
/** A eucalyptus model's triangle budget: its parts fill what its shape leaves of it. */
const GUM_TRIS = 880;

const eucalyptus: Grow = (k, r, v) => {
  const D = TREE_DIMS.eucalyptus;
  const i0 = k.idx.length;
  const bark = 0xcfcac0;
  const dead = 0xb4ad9f;
  const shed = 0xa89a88;
  const leaf = 0x5f7350;
  const cell = LEAF_CELL.gumBark;
  const h = D.h * (v === 0 ? 0.9 : v === 1 ? 0.94 : 1.04);
  const crown = D.crown * (v === 0 ? 1.4 : v === 1 ? 1.12 : 0.92);
  const C: V3 = [0, h * (v === 0 ? 0.64 : 0.7), 0];
  const R: V3 = [crown, h * 0.28, crown];
  const sprays: V3[] = [];
  /** Where the parts go: each stem's axis and girth, its fork, and its limbs' middles. */
  const stems: { at: (y: number) => V3; girth: (y: number) => number; foot: V3; fork: number; T: V3; mids: [V3, number][] }[] = [];
  const a0 = r() * Math.PI * 2;
  /** One stem from `foot` leaning `lean` toward `a`, forking at `fork` into `nL` limbs spread `spread` wide. */
  const stem = (foot: V3, a: number, lean: number, hs: number, rs: number, fork: number, nL: number, spread: [number, number], seg: number, roughTo = 0, roughMax = 1) => {
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
    // The old bark of the foot thins out up the stem flake by flake into the smooth bark: one bark, not a sleeve.
    const rough = roughTo > 0 ? (i: number) => roughMax * (1 - smoothstep(roughTo * 0.25, roughTo * 1.2, tp[i][1] - foot[1])) : undefined;
    k.tube(tp, tr, seg, bark, { cell, rough });
    const T = at(fork);
    const girth = (y: number) => {
      const f = Math.min(nS, Math.max(1, (y / fork) * nS));
      const i = Math.min(nS - 1, Math.floor(f));
      return tr[i] + (tr[i + 1] - tr[i]) * (f - i);
    };
    const mids: [V3, number][] = [];
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
      mids.push([mid, rs * 0.42]);
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
    stems.push({ at, girth, foot, fork, T, mids });
  };
  if (v === 0) {
    // The old red gum: thick, low-forked, broad, rough-footed.
    roots(k, r, 5, D.trunk * 1.55, 2.8, bark, { cell, rough: () => 0.95 });
    stem([0, 0, 0], a0, 0.03 + r() * 0.04, h, D.trunk * 1.3, h * (0.3 + r() * 0.05), 4, [0.65, 1.0], 8, 2.6 + r() * 1.4);
  } else if (v === 1) {
    roots(k, r, 4, D.trunk * 1.1, 2.4, bark, { cell, rough: () => 0.55 });
    for (let s = 0; s < 3; s++) {
      const a = a0 + (s / 3) * Math.PI * 2 + (r() - 0.5) * 0.5;
      stem([0, 0, 0], a, 0.15 + r() * 0.1, h * (0.86 + r() * 0.12), D.trunk * 0.6, h * (0.42 + r() * 0.08), 2, [0.38, 0.68], 6, 1.4, 0.7);
    }
  } else {
    // The V: a short common bole, then two stems leaning apart.
    roots(k, r, 5, D.trunk * 1.25, 2.4, bark, { cell, rough: () => 0.6 });
    const forkY = 1.3 + r() * 0.8;
    const bole: V3[] = [[0, -0.3, 0], [0, forkY * 0.5, 0], [0, forkY + 0.3, 0]];
    k.tube(bole, [D.trunk * 1.5, D.trunk * 1.2, D.trunk * 1.05], 8, bark, { cell, rough: (i) => 0.75 * (1 - smoothstep(0.2, forkY + 0.3, bole[i][1])) });
    for (const sgn of [0, Math.PI]) {
      const a = a0 + sgn + (r() - 0.5) * 0.3;
      const off: V3 = [Math.cos(a) * D.trunk * 0.35, forkY, Math.sin(a) * D.trunk * 0.35];
      stem(off, a, 0.17 + r() * 0.09, h - forkY, D.trunk * 0.72, (h - forkY) * (0.5 + r() * 0.08), 2, [0.3, 0.6], 6);
    }
  }
  for (const p of sprays) gumSpray(k, r, p, C, R, leaf);
  // The parts, from their own numbers so the shape above stays as it was, most telling first and only while the model stays
  // within its triangle budget (a grove of them is a lot of trees).
  const q = rng(Math.floor(r() * 1e6) + 1);
  const budget = (cost: number) => (k.idx.length - i0) / 3 + cost <= GUM_TRIS;
  const out = (ang: number): V3 => [Math.cos(ang), 0, Math.sin(ang)];
  // Ribbons of shed bark caught at each fork, hanging down the stem a little off it, twisting as they go.
  for (const st of stems) {
    const nF = v === 0 ? 3 : 1 + (q() < 0.5 ? 1 : 0);
    for (let i = 0; i < nF && budget(6); i++) {
      const ang = q() * Math.PI * 2;
      const o = out(ang);
      const len = 0.6 + q() * (v === 0 ? 1.6 : 1.1);
      const y0 = st.fork - 0.1 - q() * 0.5;
      const twist = (q() - 0.5) * 2.4;
      const pts: V3[] = [];
      const side: V3[] = [];
      const hw: number[] = [];
      for (let j = 0; j < 4; j++) {
        const f = j / 3;
        const y = y0 - len * f;
        const lift = st.girth(y - st.foot[1]) * 1.04 + 0.015 + f * f * 0.12;
        const ax = st.at(y - st.foot[1]);
        const sw = ang + twist * f * 0.4;
        pts.push([ax[0] + Math.cos(sw) * lift, y, ax[2] + Math.sin(sw) * lift]);
        side.push(turn([-o[2], 0, o[0]], [0, 1, 0], twist * f * 0.5));
        hw.push((0.035 + q() * 0.03) * (1 - f * 0.45));
      }
      k.ribbon(pts, side, hw, shed, BARK.gum2, cell);
    }
  }
  // Dead stubs where a small limb broke off long ago, weathered grey.
  for (const st of stems) {
    const nD = 1 + (v === 0 && q() < 0.6 ? 1 : 0);
    for (let i = 0; i < nD && budget(8); i++) {
      const y = st.fork * (0.35 + q() * 0.6);
      const ax = st.at(y);
      const g = st.girth(y);
      const d = norm([Math.cos(q() * 6.283), 0.35 + q() * 0.4, Math.sin(q() * 6.283)]);
      const sr = 0.04 + q() * 0.04;
      k.tube([add(ax, mul(d, g * 0.6)), add(ax, mul(d, g + 0.15 + q() * 0.35))], [sr, sr * 0.3], 4, dead, { cell, bark: BARK.silver, hull: false });
    }
  }
  // Ribbons hanging free from the limbs.
  for (const st of stems) {
    for (const [mid, mr] of st.mids) {
      if (q() < 0.35 || !budget(6)) continue;
      const len = 0.5 + q() * 1.2;
      const ang = q() * Math.PI * 2;
      const o = out(ang);
      const twist = (q() - 0.5) * 3;
      const top: V3 = [mid[0] + o[0] * mr * 0.6, mid[1] - mr * 0.8, mid[2] + o[2] * mr * 0.6];
      const pts: V3[] = [];
      const side: V3[] = [];
      const hw: number[] = [];
      for (let j = 0; j < 4; j++) {
        const f = j / 3;
        pts.push([top[0] + o[0] * 0.08 * f * f, top[1] - len * f, top[2] + o[2] * 0.08 * f * f]);
        side.push(turn([-o[2], 0, o[0]], [0, 1, 0], twist * f));
        hw.push((0.03 + q() * 0.025) * (1 - f * 0.5));
      }
      k.ribbon(pts, side, hw, shed, BARK.gum2, cell);
    }
  }
};

const GROW: Record<TreeSpecies, Grow> = { oak, pine, willow, poplar, palm, acacia, cypress, snag, eucalyptus };
/** Each species' bark (`barkTex.ts`): oak and acacia fissured, a pine's plates, a willow's deep net, a poplar smooth over a fissured foot. */
const SPECIES_BARK: Record<TreeSpecies, number> = {
  oak: BARK.furrow,
  pine: BARK.plate,
  willow: BARK.interlace,
  poplar: BARK.smooth,
  palm: BARK.palm,
  acacia: BARK.furrow,
  cypress: BARK.fibre,
  snag: BARK.silver,
  eucalyptus: BARK.gum,
};

const speciesGeos: THREE.BufferGeometry[] = [];

/** All three variants of a species in one geometry (`tree.y` says which variant a vertex belongs to). Built once. */
export function treeGeometry(sp: number): THREE.BufferGeometry {
  const hit = speciesGeos[sp];
  if (hit) return hit;
  const k = new TreeKit();
  k.sp = sp;
  for (let v = 0; v < 3; v++) {
    k.variant = v;
    k.barkLayer = SPECIES_BARK[TREE_SPECIES[sp]];
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
  const TS = g.attributes.tree.itemSize;
  const I = g.index!.array;
  let hw = 0;
  let top = 0;
  for (let i = 0; i < P.length / 3; i++) {
    if (T[i * TS + 1] !== 0) continue;
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
    if (T[a * TS + 1] !== 0) continue;
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
// A tree's own two random numbers, from its leaf tint: the stump and the falling top of a snapped tree keep them.
vec2 barkSeed( vec3 tint ) {
  return fract( sin( vec2( dot( tint.rg, vec2( 127.1, 311.7 ) ), dot( tint.gb, vec2( 269.5, 183.3 ) ) ) ) * 43758.5453 );
}
// Darker barks only a little lighter or darker, warmer or greyer.
vec3 barkTint( vec3 c, vec2 s ) {
  vec3 bt = s.x < 0.26 ? vec3( 1.06, 1.06, 1.08 ) : s.x < 0.48 ? vec3( 1.03, 0.96, 0.86 ) : s.x < 0.64 ? vec3( 1.04, 0.8, 0.64 ) : s.x < 0.8 ? vec3( 1.01, 0.88, 0.82 ) : vec3( 0.8, 0.76, 0.7 );
  vec3 dk = vec3( 1.0 + ( s.y - 0.5 ) * 0.16, 1.0 + ( s.y - 0.5 ) * 0.08, 1.0 - ( s.y - 0.5 ) * 0.06 ) * ( 0.9 + s.x * 0.2 );
  float pale = smoothstep( 0.22, 0.42, dot( c, vec3( 0.3333 ) ) );
  return mix( dk, bt, pale );
}
`;

/**
 * The bark's fragment work (`barkTex.ts`): wood samples its layer in metres instead of the atlas, fades in its rough partner
 * by the rough layer's own relief, varies broadly in tone along the stem, and keeps its relief (`tBarkH`, metres per unit in
 * `tBarkDepth`) for the bump in the normal.
 */
const BARK_PARS = /* glsl */ `
uniform highp sampler2DArray tBark;
varying vec4 vBark;
const float BARK_DEPTH[${BARK_DEPTH.length}] = float[]( ${BARK_DEPTH.map((d) => d.toFixed(4)).join(', ')} );
float barkRoughScale( float l ) {
  ${[...new Map(Object.values(BARK_ROUGH).map((p) => [p!.layer, p!.scale]))]
    .map(([l, k]) => `if ( l == ${l.toFixed(1)} ) return ${k.toFixed(1)};`)
    .join('\n  ')}
  return 1.0;
}
`;
const BARK_MAP = /* glsl */ `
float tBarkH = -1.0;
float tBarkDepth = 0.0;
// How many bark texels a pixel spans: under one, the layer is magnified and a finer grain fades in.
float tBarkFine = 1.0 - smoothstep( 0.5, 1.4, length( fwidth( vBark.xy ) ) * ${BARK_SIZE}.0 );
#ifdef USE_MAP
if ( vBark.z < -0.5 ) {
  diffuseColor *= texture2D( map, vMapUv );
} else {
  float bl = floor( vBark.z + 0.5 );
  vec4 bk = texture( tBark, vec3( vBark.xy, bl ) );
  float bh = bk.a;
  tBarkDepth = BARK_DEPTH[ int( bl ) ];
  // Broad changes of tone up the stem: the layer's own relief, far coarser and blurred.
  vec2 macS = BARK_MAC[ int( bl ) ];
  float mac = clamp( ( texture( tBark, vec3( vBark.x + 0.37, vBark.y * 0.19 + 0.21, bl ), 4.0 ).a - macS.x ) / ( macS.y * 2.5 ), -1.0, 1.0 );
  float ra = fract( vBark.w );
  // The rough foot gives out higher on one side than the other, never in a level ring.
  ra = ra > 0.004 ? clamp( ra + mac * 0.3, 0.0, 1.0 ) : 0.0;
  if ( ra > 0.004 ) {
    // The rough layer outlasts the smooth where it is thickest: its thin edges give out first as it fades up the stem.
    float rl = floor( vBark.w );
    vec4 rk = texture( tBark, vec3( vBark.xy * barkRoughScale( rl ), rl ) );
    float m = smoothstep( -0.05, 0.05, rk.a - ( 1.0 - ra ) );
    bk.rgb = mix( bk.rgb, rk.rgb, m );
    bh = mix( bh, 0.45 + rk.a * 0.55, m );
    tBarkDepth = mix( tBarkDepth, BARK_DEPTH[ int( rl ) ], m );
  }
  if ( tBarkFine > 0.01 ) {
    // Close up, the same bark four times finer over it: grain where the layer alone would go soft.
    float fine = texture( tBark, vec3( vBark.xy * 4.0 + vec2( 0.31, 0.57 ), bl ) ).a - 0.5;
    bk.rgb *= 1.0 + fine * 0.18 * tBarkFine;
    bh += fine * 0.22 * tBarkFine;
  }
  diffuseColor.rgb *= bk.rgb * ( 1.0 + 0.1 * mac );
  tBarkH = bh;
}
#endif
`;
const BARK_NORMAL = /* glsl */ `
vec3 tBpx = dFdx( -vViewPosition );
vec3 tBpy = dFdy( -vViewPosition );
vec2 tBh = vec2( dFdx( tBarkH ), dFdy( tBarkH ) ) * tBarkDepth;
if ( tBarkH >= 0.0 ) {
  // Wood is closed or two-sided: light whichever side faces the camera. Then the bark's relief as a bump (its slope on
  // screen, no extra fetch), in metres.
  normal *= faceDirection;
  vec3 r1 = cross( tBpy, normal );
  vec3 r2 = cross( normal, tBpx );
  float det = dot( tBpx, r1 );
  normal = normalize( abs( det ) * normal - sign( det ) * ( tBh.x * r1 + tBh.y * r2 ) );
}
`;

function encode(tint: V3, slot: number, out: THREE.Color) {
  return out.setRGB(tint[0] + slot * 4, tint[1], tint[2], THREE.LinearSRGBColorSpace);
}

/**
 * A tree's wound, per instance (`aNotch`, `aNotchB`, see `setTreeNotch`), in its own model space: where gunfire has chewed
 * a notch into the stem and how deep, and, once it has snapped there, which piece this instance draws. The falling top
 * (mode 1) keeps the wood above a jagged break and all the leaves; the stump (mode -1) keeps the wood below it. The break
 * is jagged (long splinters on the hinge side, away from the notch) and the open end of the stem is closed by drawing its
 * inside as the cut face: a back face of the wood near the break shows the end grain where the view ray crosses the break
 * plane, lit as that plane. No extra geometry: the same buffers, two vec4s a tree.
 */
const WOUND_V = /* glsl */ `
attribute vec4 aNotch;
attribute vec4 aNotchB;
varying vec3 vTL;
varying vec4 vTN;
varying vec4 vTNB;
varying float vTWood;
`;
const WOUND_F = /* glsl */ `
varying vec3 vTL;
varying vec4 vTN;
varying vec4 vTNB;
varying float vTWood;
float treeJag( vec2 rel, float ang, float r ) {
  float th = atan( rel.y, rel.x );
  float hinge = 0.5 - 0.5 * cos( th - ang );
  float t1 = abs( fract( th * 1.4324 + 0.37 ) - 0.5 ) * 2.0;
  float t2 = abs( fract( th * 3.5014 + 0.11 ) - 0.5 ) * 2.0;
  return r * ( 0.12 + 0.88 * hinge ) * ( 0.6 * t1 * t1 + 0.28 * t2 );
}
bool treeCutAway() {
  if ( vTN.w == 0.0 ) return false;
  vec2 rel = vTL.xz - vTNB.xy;
  float cut = vTN.x + treeJag( rel, vTN.z, vTNB.z ) - vTNB.z * 0.2;
  if ( vTN.w > 0.0 ) {
    if ( vTWood > 0.5 && vTL.y < cut ) return true;
  } else if ( vTWood < 0.5 || vTL.y > cut ) return true;
  // Wood inside the stem near the break (a root's start, a gum's smooth stem in its rough sleeve) is never really seen.
  return vTWood > 0.5 && gl_FrontFacing && length( rel ) < vTNB.z * 0.78 && abs( vTL.y - vTN.x ) < vTNB.z * 3.0;
}
`;
const WOUND_COLOUR = /* glsl */ `
varying vec3 vTCam;
varying vec3 vTCapN;
float tHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float tNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( tHash( i ), tHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( tHash( i + vec2( 0.0, 1.0 ) ), tHash( i + 1.0 ), f.x ), f.y );
}
// The pale wood under the bark, the darker heart, the end grain of the break and the chewed notch. 'cap' is set where
// this fragment draws the break's face (it is then lit as that face).
void treeWound( inout vec3 col, out float cap ) {
  cap = 0.0;
  if ( vTWood < 0.5 || ( vTN.y <= 0.0 && vTN.w == 0.0 ) ) return;
  vec2 rel = vTL.xz - vTNB.xy;
  float r = max( vTNB.z, 1e-3 );
  vec3 sap = mix( vec3( 0.46, 0.34, 0.2 ), col * 2.2, 0.2 );
  if ( vTN.w != 0.0 && !gl_FrontFacing ) {
    if ( length( rel ) > r * 1.35 || abs( vTL.y - vTN.x ) > r * 4.0 ) return;
    vec3 d = vTL - vTCam;
    float t = ( vTN.x - vTCam.y ) / ( abs( d.y ) > 1e-4 ? d.y : 1e-4 );
    vec2 q = vTCam.xz + d.xz * t - vTNB.xy;
    float rr = length( q ) / r;
    if ( rr > 1.25 ) return;
    float a = atan( q.y, q.x );
    float ring = 0.5 + 0.5 * sin( rr * 38.0 + tNoise( vec2( a * 3.0, rr * 4.0 ) ) * 2.5 );
    vec3 heart = sap * vec3( 0.66, 0.46, 0.34 );
    vec3 wood = mix( heart, sap, smoothstep( 0.2, 0.72, rr ) ) * ( 0.8 + 0.2 * ring );
    wood *= 0.74 + 0.36 * tNoise( q * 30.0 / r );
    col = mix( wood, col * 0.8, smoothstep( 0.9, 1.05, rr ) );
    cap = 1.0;
    return;
  }
  if ( vTN.y > 0.0 && gl_FrontFacing ) {
    float rad = length( rel );
    if ( rad > r * 2.2 ) return;
    float th = atan( rel.y, rel.x );
    float side = dot( rel / max( rad, 1e-4 ), vec2( cos( vTN.z ), sin( vTN.z ) ) );
    float hy = vTL.y / max( vTNB.w, 0.05 );
    float n = tNoise( vec2( th * 6.0, hy * 5.0 ) );
    // Fibres run along the grain; pits are where rounds went in.
    float fib = tNoise( vec2( th * 40.0, hy * 1.5 ) );
    float pit = tNoise( vec2( th * 18.0, hy * 14.0 ) );
    float dy = abs( vTL.y - vTN.x ) / max( vTNB.w, 1e-3 ) + ( n - 0.5 ) * 0.7;
    float wrap = mix( 0.75, -0.85, clamp( vTN.y * 1.4, 0.0, 1.0 ) );
    float chew = ( 1.0 - smoothstep( 0.7, 0.85, dy ) ) * smoothstep( wrap - 0.15, wrap + 0.15, side + ( n - 0.5 ) * 0.5 ) * smoothstep( 0.0, 0.06, vTN.y );
    float deep = ( 1.0 - clamp( dy, 0.0, 1.0 ) ) * clamp( vTN.y * 1.6, 0.0, 1.0 );
    vec3 torn = sap * ( 0.5 + 0.6 * fib ) * mix( 1.0, 0.4, deep ) * mix( 1.0, 0.3, smoothstep( 0.55, 0.8, pit ) * ( 0.4 + 0.6 * deep ) );
    // The torn lip of the bark round it is darker than either.
    torn *= 1.0 - 0.45 * smoothstep( 0.45, 0.7, dy );
    col = mix( col, torn, chew );
  }
}
`;

const glslFloats = (k: 'h' | 'lean' | 'hz' | 'leaf') => `float[${TREE_WIND.length}]( ${TREE_WIND.map((w) => w[k].toFixed(4)).join(', ')} )`;

/**
 * A tree's trunk in the wind, shared by the 3D trees and their impostors so the two halves of the cross-fade agree. At model
 * height `y`, for species `s` at scale `tS` with its own timing `ph`, in the air `wh` (`windHere`), `W` downwind and `C`
 * across the wind in the tree's frame: it leans over as the wind presses it (a big tree further, but slower than a small
 * one), sways about that lean at its own pace and a little across the wind, and bends most toward its top.
 */
const TREE_TRUNK_GLSL = /* glsl */ `
const float TREE_BEND_H[${TREE_WIND.length}] = ${glslFloats('h')};
const float TREE_LEAN[${TREE_WIND.length}] = ${glslFloats('lean')};
const float TREE_HZ[${TREE_WIND.length}] = ${glslFloats('hz')};
const float TREE_LEAF_HZ[${TREE_WIND.length}] = ${glslFloats('leaf')};

vec3 treeTrunk( int s, float y, float tS, float ph, vec4 wh, vec3 W, vec3 C ) {
  float h = max( y, 0.0 ) / TREE_BEND_H[ s ];
  float w = TREE_HZ[ s ] * 6.2832 * inversesqrt( tS );
  float D = windTrunk( wh.z ) * TREE_LEAN[ s ] * pow( tS, -0.3 ) * uWind.w;
  float o = sin( uTime * w + ph ) * 0.75 + sin( uTime * w * 2.7 + ph * 2.0 ) * 0.25;
  return ( W * ( 1.0 + 0.45 * o ) + C * 0.3 * sin( uTime * w * 1.13 + ph * 1.7 ) ) * D * h * h;
}
`;

/**
 * A 3D tree's vertex in the wind (`treeWindData` says what each vertex is). Wood and leaves answer the wind by their size:
 * a leaf stirs in a breath of air, a twig in a breeze, a limb in a wind, the trunk only in a gale.
 */
const TREE_SWAY_GLSL = /* glsl */ `
// The unit axis a leaf grows along (octahedral, 12 bits a side, folded about y).
vec3 treeLeafAxis( float w ) {
  float qv = floor( w / 4096.0 );
  vec2 f = vec2( w - qv * 4096.0, qv ) / 4095.0 * 2.0 - 1.0;
  vec3 n = vec3( f.x, 1.0 - abs( f.x ) - abs( f.y ), f.y );
  float t = max( -n.y, 0.0 );
  n.x += n.x >= 0.0 ? -t : t;
  n.z += n.z >= 0.0 ? -t : t;
  return normalize( n );
}

// p (a vertex in the tree's own frame) moved by the wind; n, its normal, turns with a leaf.
vec3 treeSway( vec3 p, inout vec3 n ) {
#ifdef USE_INSTANCING
  mat3 tM = mat3( instanceMatrix );
  float tS = length( tM[ 1 ] );
  mat3 tR = mat3( normalize( tM[ 0 ] ), tM[ 1 ] / tS, normalize( tM[ 2 ] ) );
  // Only a standing tree sways: a falling top, or a tree down on the ground, is done with the wind.
  float stand = smoothstep( 0.75, 0.97, tR[ 1 ].y ) * ( aNotch.w > 0.5 ? 0.0 : 1.0 );
  if ( stand * uWind.w <= 0.0 ) return p;
  vec3 tO = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  vec4 wh = windHere( tO.xz );
  wh.zw *= stand;
  vec3 W = transpose( tR ) * vec3( wh.x, 0.0, wh.y );
  vec3 U = transpose( tR ) * vec3( 0.0, 1.0, 0.0 );
  vec3 C = cross( U, W );
  float ph = windSeed( tO.xz );
  float q = tree.z;
  float sp = floor( q / 262144.0 );
  q -= sp * 262144.0;
  float pl = floor( q / 4096.0 );
  q -= pl * 4096.0;
  float p2 = floor( q / 64.0 );
  float p1 = q - p2 * 64.0;
  int s = int( sp + 0.5 );
  float f2 = floor( tree.w / 4096.0 );
  float f1 = ( tree.w - f2 * 4096.0 ) * 0.001;
  f2 *= 0.001;
  vec3 pos = p;
  // A leaf turns about the point it grows from: pushed round downwind (the more squarely it meets the wind, the more),
  // fluttering about that, twisting about its own axis, its tip a beat behind its base. Leaves growing alike move alike,
  // each at the time the angle it grows at gives it, and a gust reaches the near side of the crown before the far.
  if ( tree.x > 0.0 ) {
    vec3 hinge = aLeaf.xyz;
    vec3 ax = treeLeafAxis( aLeaf.w );
    vec3 rel = p - hinge;
    float drive = windLeaf( wh.w ) * tree.x * uWind.w;
    float t = uTime * TREE_LEAF_HZ[ s ] * 6.2832 + pl * 0.0982 - dot( hinge, W ) * 0.25;
    float lag = length( rel ) * 1.1;
    float flap = sin( t - lag ) + 0.35 * min( wh.w * 0.1, 1.0 ) * sin( t * 2.63 + pl * 0.17 - lag * 1.6 );
    float twist = sin( t * 1.37 + pl * 0.23 );
    vec3 om = ( cross( ax, W ) * ( 0.22 + 0.13 * flap ) + ax * 0.15 * twist + U * 0.05 * flap ) * drive;
    pos = hinge + windTurn( rel, om );
    n = windTurn( n, om );
  }
  // Limbs and twigs: each swings at its own time (set by the way it grows) about a lean downwind, bobbing as it goes. A twig
  // rides its limb and a leaf its twig, so whatever grows from a piece moves with it.
  float bw = TREE_HZ[ s ] * 6.2832 * inversesqrt( tS );
  float a1 = p1 * 0.0982 + ph;
  float a2 = p2 * 0.0982 + ph;
  float o1 = sin( uTime * bw * 2.4 + a1 );
  float o1b = sin( uTime * bw * 3.1 + a1 * 1.7 + 1.0 );
  float o2 = sin( uTime * bw * 5.0 + a2 );
  float o2b = sin( uTime * bw * 6.3 + a2 * 1.9 + 2.0 );
  float d1 = windLimb( mix( wh.z, wh.w, 0.4 ) ) * f1 * uWind.w;
  float d2 = windTwig( wh.w ) * f2 * uWind.w;
  pos += W * ( d1 * ( 0.55 + 0.45 * o1 ) + d2 * ( 0.5 + 0.5 * o2 ) ) + U * ( d1 * 0.35 * o1b + d2 * 0.4 * o2b ) + C * ( d1 * 0.25 * o1b + d2 * 0.3 * o2b );
  // The trunk carries all of it, keeping its length as it bends.
  float len = length( pos );
  vec3 bent = pos + treeTrunk( s, p.y, tS, ph, wh, W, C );
  return len > 1e-3 ? normalize( bent ) * len : bent;
#else
  return p;
#endif
}
`;

/**
 * The 3D trees' vertex work: keep only this instance's variant (and, for the colour pass, only near the camera), then sway
 * (`treeSway`, the same in the shadow). Variant indices remove unused models before submission; the guard remains for
 * callers using the complete species geometry. The colour pass also skips trees beyond the cross-fade before lighting.
 */
function treeVertex(shader: THREE.WebGLProgramParametersWithUniforms, colour: boolean) {
  windUniforms(shader);
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
    .replace(
      '#include <common>',
      `#include <common>\nattribute vec4 tree;\nattribute vec4 aLeaf;\nuniform vec2 uTreeLod;\n${WOUND_V}${WIND_GLSL}${TREE_TRUNK_GLSL}${TREE_SWAY_GLSL}${colour ? 'varying float vTreeKeep;\nvarying vec3 vTCam;\nvarying vec3 vTCapN;' : ''}`,
    )
    .replace(colour ? '#include <uv_vertex>' : '#include <project_vertex>', colour ? `${keep}\n#include <uv_vertex>` : `${keep}\n#include <project_vertex>`)
    // A leaf's normal turns with it, so the light glints and darkens on it as it moves.
    .replace('#include <beginnormal_vertex>', colour ? '#include <beginnormal_vertex>\nvec3 tSwayed = treeSway( position, objectNormal );' : '#include <beginnormal_vertex>')
    .replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
vTL = position;
vTN = aNotch;
vTNB = aNotchB;
vTWood = tree.x > 0.0 ? 0.0 : 1.0;
${
  colour
    ? `vTCam = vec3( 0.0 );
vTCapN = vec3( 0.0, 1.0, 0.0 );
#ifdef USE_INSTANCING
if ( aNotch.w != 0.0 ) {
  // Where the camera is in the tree's own frame, for the view ray through the break's face, and that face's normal.
  vTCam = ( inverse( modelMatrix * instanceMatrix ) * vec4( cameraPosition, 1.0 ) ).xyz;
  vTCapN = normalize( normalMatrix * ( mat3( instanceMatrix ) * vec3( 0.0, aNotch.w < 0.0 ? 1.0 : -1.0, 0.0 ) ) );
}
#endif`
    : ''
}
${colour ? 'transformed = tSwayed;' : '{\n  vec3 tN = vec3( 0.0, 1.0, 0.0 );\n  transformed = treeSway( position, tN );\n}'}`,
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
    shader.uniforms.tBark = { value: barkTextures() };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\nattribute vec4 bark;\nvarying vec4 vBark;\n${BARK_FN}`);
    // Each tree its own bark: tinted, its layer laid from its own place round and up the stem, a gum's patches its own.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <color_vertex>',
      `#include <color_vertex>\nvBark = bark;\n#ifdef USE_INSTANCING_COLOR\n{\n${DECODE}\nvec2 bS = barkSeed( treeTint );\nvColor = vec4( color * ( bark.z < 0.0 ? treeTint : barkTint( color, bS ) ), 1.0 );\nif ( bark.z >= 0.0 ) {\n  vBark.xy += bS * vec2( 7.0, 13.0 );\n  if ( fract( bark.w ) > 0.0 ) vBark.w = floor( bark.w ) + clamp( fract( bark.w ) + ( fract( bS.x * 5.17 ) - 0.5 ) * 0.4, 0.0, 0.99 );\n  if ( bark.z == ${BARK.gum.toFixed(1)} && fract( bS.y * 7.31 ) > 0.5 ) vBark.z = ${BARK.gum2.toFixed(1)};\n}\n}\n#endif`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying float vTreeKeep;\n${DITHER}\n${WOUND_F}\n${WOUND_COLOUR}\n${BARK_PARS}\nconst vec2 BARK_MAC[${barkStats().length}] = vec2[]( ${barkStats().map(([m, d]) => `vec2( ${m.toFixed(4)}, ${d.toFixed(4)} )`).join(', ')} );`,
      )
      .replace('#include <map_fragment>', BARK_MAP)
      .replace(
        '#include <alphatest_fragment>',
        '#include <alphatest_fragment>\nif ( treeDither( gl_FragCoord.xy ) >= vTreeKeep ) discard;\nif ( treeCutAway() ) discard;\nfloat tCap = 0.0;\ntreeWound( diffuseColor.rgb, tCap );',
      )
      // Leaf normals were bent round the crown: keep them whichever side of a card faces the camera. A break's face is lit as
      // the plane it is.
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\nnormal = normalize( vNormal );\n${BARK_NORMAL}\nif ( tCap > 0.5 ) normal = normalize( vTCapN );`);
  };
  m.customProgramCacheKey = () => 'tree3d';
  return (treeMat = shared(m));
}

/** The 3D trees' shadow pass: the same variant pick and sway (three copies the atlas and alpha test in), and the same break. */
export function treeDepthMaterial(): THREE.MeshDepthMaterial {
  if (treeDepth) return treeDepth;
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (shader) => {
    treeVertex(shader, false);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${WOUND_F}`)
      .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\nif ( treeCutAway() ) discard;');
  };
  m.customProgramCacheKey = () => 'tree3d-depth';
  return (treeDepth = shared(m));
}

export interface LoadedMask {
  tLoaded: { value: THREE.Texture | null };
  uLoadedRect: { value: THREE.Vector4 };
}

function impostorShader(shader: THREE.WebGLProgramParametersWithUniforms, far: LoadedMask | null) {
  shader.uniforms.uTreeLod = LOD_U.uTreeLod;
  windUniforms(shader);
  if (far) Object.assign(shader.uniforms, far);
  // Each species' impostor card is its model's height: a card's height share is a height on the model.
  const impH = `const float TREE_IMP_H[${TREE_SPECIES.length}] = float[${TREE_SPECIES.length}]( ${TREE_SPECIES.map((_, sp) => impostorDims(sp).h.toFixed(4)).join(', ')} );`;
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>\nattribute vec3 tang;\nvarying vec3 vImpT;\nvarying vec2 vImpUv;\nvarying float vImpKeep;\nuniform vec2 uTreeLod;\n${WIND_GLSL}${TREE_TRUNK_GLSL}${impH}\n${far ? 'uniform sampler2D tLoaded;\nuniform vec4 uLoadedRect;\nvarying float vFarCut;' : ''}`,
    )
    .replace('#include <color_vertex>', `#include <color_vertex>\n#ifdef USE_INSTANCING_COLOR\n{\n${DECODE}\nvColor = vec4( treeTint, 1.0 );\n}\n#endif`)
    .replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
${far ? 'vFarCut = 0.0;' : ''}
#if defined( USE_INSTANCING ) && defined( USE_INSTANCING_COLOR )
{
  ${DECODE}
  vec3 iO = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  ${
    far
      ? `// Inside a loaded chunk the chunk draws its own trees: this one dissolves out as they dissolve in (dissolve.ts).
  vec2 iLc = ( iO.xz - uLoadedRect.xy ) / uLoadedRect.zw;
  vFarCut = ( iLc.x >= 0.0 && iLc.y >= 0.0 && iLc.x < 1.0 && iLc.y < 1.0 ) ? texture2D( tLoaded, iLc ).r : 0.0;
  float iKeep = vFarCut >= 1.0 ? 0.0 : 1.0;`
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
  {
    // The far tree's trunk sways as its 3D self's does (same air, same timing), so the cross-fade between them never shows.
    int s = int( treeSlot + 0.5 );
    mat3 iM = mat3( instanceMatrix );
    vec3 iSc = vec3( length( iM[ 0 ] ), length( iM[ 1 ] ), length( iM[ 2 ] ) );
    mat3 iR = mat3( iM[ 0 ] / iSc.x, iM[ 1 ] / iSc.y, iM[ 2 ] / iSc.z );
    float tS = iSc.y / TREE_IMP_H[ s ];
    vec4 wh = windHere( iO.xz );
    vec3 W = transpose( iR ) * vec3( wh.x, 0.0, wh.y );
    vec3 C = cross( vec3( 0.0, 1.0, 0.0 ), W );
    transformed += treeTrunk( s, transformed.y * TREE_IMP_H[ s ], tS, windSeed( iO.xz ), wh, W, C ) * tS / iSc;
  }
}
#endif`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vImpT;\nvarying vec2 vImpUv;\nvarying float vImpKeep;\n${DITHER}`)
    .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\nif ( treeDither( gl_FragCoord.xy ) < 1.0 - vImpKeep ) discard;')
    .replace('#include <clipping_planes_fragment>', far ? FAR_CUT_FRAG : '#include <clipping_planes_fragment>')
    .replace('#include <common>', far ? `#include <common>\n${FAR_CUT_FRAG_PARS}` : '#include <common>')
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

/**
 * A mesh's own geometry for a model: the shared buffers of `source`, plus the per-tree wound data (`setTreeNotch`) sized for
 * `capacity` instances. Marked shared so a scene teardown never frees the model's buffers through it; `releaseWoundGeometry`
 * frees only its own (it runs when its mesh is disposed).
 */
function woundGeometry(source: THREE.BufferGeometry, capacity: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) geo.setAttribute(name, attribute);
  geo.setIndex(source.index);
  geo.boundingBox = source.boundingBox?.clone() ?? null;
  geo.boundingSphere = source.boundingSphere?.clone() ?? null;
  geo.setAttribute('aNotch', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
  geo.setAttribute('aNotchB', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
  return shared(geo);
}

function releaseWoundGeometry(geo: THREE.BufferGeometry) {
  for (const name of Object.keys(geo.attributes)) if (name !== 'aNotch' && name !== 'aNotchB') geo.deleteAttribute(name);
  geo.setIndex(null);
  geo.dispose();
}

/**
 * Lay a tree's wound on its 3D instance (all in the tree's model units): the notch's height, the share of the section gone
 * there, the side it faces (radians in the model's x-z plane), the piece drawn (0 the standing tree, 1 its falling top, -1
 * its stump), the stem's centre and radius at the notch, and the notch's half height.
 */
export function setTreeNotch(mesh: THREE.InstancedMesh, i: number, y: number, share: number, angle: number, mode: number, cx: number, cz: number, r: number, half: number) {
  const a = mesh.geometry.getAttribute('aNotch') as THREE.InstancedBufferAttribute | undefined;
  const b = mesh.geometry.getAttribute('aNotchB') as THREE.InstancedBufferAttribute | undefined;
  if (!a || !b || i >= a.count) return;
  a.setXYZW(i, y, share, angle, mode);
  b.setXYZW(i, cx, cz, r, half);
  a.addUpdateRange(i * 4, 4);
  b.addUpdateRange(i * 4, 4);
  a.needsUpdate = true;
  b.needsUpdate = true;
}

/**
 * Another instance of a mesh's tree in the next free slot, a copy of instance `from` (a snapped tree's stump: its top keeps
 * the original slot and goes where the falling body goes). Returns the slot, or -1 if the mesh has none left.
 */
export function addTreeSlot(mesh: THREE.InstancedMesh, from: number): number {
  if (mesh.count >= mesh.instanceMatrix.count) return -1;
  const i = mesh.count++;
  mesh.getMatrixAt(from, _m);
  mesh.setMatrixAt(i, _m);
  mesh.instanceMatrix.addUpdateRange(i * 16, 16);
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.getColorAt(from, _c);
    mesh.setColorAt(i, _c);
    mesh.instanceColor.addUpdateRange(i * 3, 3);
    mesh.instanceColor.needsUpdate = true;
  }
  for (const name of ['aNotch', 'aNotchB']) {
    const a = mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute | undefined;
    if (!a) continue;
    a.setXYZW(i, a.getX(from), a.getY(from), a.getZ(from), a.getW(from));
    a.addUpdateRange(i * 4, 4);
    a.needsUpdate = true;
  }
  return i;
}

/** A chunk's trees in slices: a species/variant a slice. Each mesh has room for as many again (the stumps of snapped trees). */
export function* buildTreesSteps(trees: TreeSpot[]): Generator<void, TreeSet> {
  const set: TreeSet = { near: [], far: null };
  if (!trees.length) return set;
  const inst = treeInstances(trees);
  for (let sp = 0; sp < TREE_SPECIES.length; sp++) {
    for (let variant = 0; variant < 3; variant++) {
      const mine = inst.filter((t) => t.sp === sp && t.v === variant);
      if (!mine.length) continue;
      const capacity = mine.length * 2;
      const im = new THREE.InstancedMesh(woundGeometry(treeVariantGeometry(sp, variant), capacity), treeMaterial(), capacity);
      im.count = mine.length;
      im.addEventListener('dispose', () => releaseWoundGeometry(im.geometry));
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
  for (const [geo, mat] of [[woundGeometry(treeGeometry(0), 1), treeMaterial()], [impostorGeometry(), impostorMaterial()]] as const) {
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
