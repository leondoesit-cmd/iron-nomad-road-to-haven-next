import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { MeshBuilder, type Surf } from '../builder';
import { shared } from '../dispose';

/**
 * The toolkit the weapon models are built with. A gun is laid out the way a gunsmith draws one: side profiles (a receiver,
 * a stock, a grip, a trigger guard) extruded across the gun with rounded edges, cross-sections (a slide, a rail, a
 * handguard) swept down its length, and turned parts (barrels, muzzle devices, scope tubes, screws) lathed about the bore.
 * Everything lands in one `MeshBuilder`, so a gun is still a single draw call, with one extra vertex attribute, `wpn`:
 *
 * - x: the finish (`F`), which the weapon shader turns into wood grain, stippling, checkering, parkerizing and so on;
 * - y: how much of an edge the vertex is on (0 on a flat face, 1 on the crest of a rounded edge), where the finish wears
 *   through to bare metal or lighter polymer;
 * - z: a per-part number, so two pieces of walnut on one gun are not cut from the same plank.
 *
 * Every template is cached per shape and level of detail ('hi' for the first-person view and close inspection, 'lo' for
 * a gun in someone else's hands or lying in the street): 'lo' has fewer curve and bevel segments and the callers leave the
 * small parts (screws, pins, serrations, rail slots) out.
 *
 * The weapon frame: +z down the barrel, +y up, +x to the gun's LEFT (the right side, where the bolt handles and ejection
 * ports are, is -x). Units are metres.
 */

export type Lod = 'hi' | 'lo';

/** The finishes the weapon shader knows. */
export const F = {
  none: 0,
  /** Parkerized steel: grey-green phosphate, matte, wearing to bright steel on the edges. */
  park: 1,
  /** Blued steel: deep blue-black and satin, silver on worn edges. */
  blued: 2,
  /** Hard-anodized aluminium: matte black, bright aluminium on the edges. */
  anod: 3,
  /** Moulded polymer. */
  poly: 4,
  /** Polymer with a stippled grip texture. */
  stipple: 5,
  /** Oiled wood, grain running along the gun. */
  wood: 6,
  rubber: 7,
  /** Wood with cut checkering (grips, a wrist, a fore-end). */
  checker: 8,
  /** Knurled steel (screw heads, a bolt knob, a scope turret). */
  knurl: 9,
  brass: 10,
  /** Bright stainless or polished blade steel, brushed along its length. */
  bright: 11,
  /** Cloth tape: a grip wrap, or a field repair. */
  tape: 12,
  leather: 13,
  /** Paint over steel, chipping to bare metal on the edges. */
  paint: 14,
  /** Woven cord: paracord, a sling, a bowstring. */
  cord: 15,
} as const;

/** A weapon surface: the builder's PBR numbers plus the finish. */
export interface WS extends Surf {
  f: number;
}

/** Surface presets for the materials guns are made of. `w` is grime and rust (the kit shader's wear). */
export const M = {
  park: (c = 0x2f312d, w = 0.35): WS => ({ c, r: 0.62, m: 0.5, w, f: F.park }),
  blued: (c = 0x1b1e25, w = 0.3): WS => ({ c, r: 0.32, m: 0.88, w, f: F.blued }),
  anod: (c = 0x26272a, w = 0.3): WS => ({ c, r: 0.48, m: 0.45, w, f: F.anod }),
  nitride: (c = 0x2a2b2d, w = 0.3): WS => ({ c, r: 0.42, m: 0.6, w, f: F.park }),
  poly: (c = 0x1e1f21, w = 0.3): WS => ({ c, r: 0.6, m: 0, w, f: F.poly }),
  stipple: (c = 0x1c1d1f, w = 0.3): WS => ({ c, r: 0.72, m: 0, w, f: F.stipple }),
  wood: (c = 0x5c3a22, w = 0.35): WS => ({ c, r: 0.5, m: 0, w, f: F.wood }),
  checker: (c = 0x553520, w = 0.35): WS => ({ c, r: 0.62, m: 0, w, f: F.checker }),
  rubber: (c = 0x161617, w = 0.3): WS => ({ c, r: 0.88, m: 0, w, f: F.rubber }),
  knurl: (c = 0x2a2b2e, w = 0.3): WS => ({ c, r: 0.4, m: 0.85, w, f: F.knurl }),
  brass: (c = 0xa8843e, w = 0.4): WS => ({ c, r: 0.32, m: 1, w, f: F.brass }),
  bright: (c = 0xb4b8bc, w = 0.2): WS => ({ c, r: 0.24, m: 1, w, f: F.bright }),
  steel: (c = 0x6c7074, w = 0.35): WS => ({ c, r: 0.38, m: 0.95, w, f: F.none }),
  tape: (c = 0x1c1c1e, w = 0.45): WS => ({ c, r: 0.8, m: 0, w, f: F.tape }),
  leather: (c = 0x3a2416, w = 0.4): WS => ({ c, r: 0.6, m: 0, w, f: F.leather }),
  paint: (c: number, w = 0.45): WS => ({ c, r: 0.45, m: 0.1, w, f: F.paint }),
  cord: (c = 0x2a2c26, w = 0.4): WS => ({ c, r: 0.9, m: 0, w, f: F.cord }),
  /** The dark inside of a bore, a port or a slot. */
  hole: (): WS => ({ c: 0x050505, r: 0.85, m: 0.4, w: 0, f: F.none }),
  /** Painted sight dots and outlines. */
  dot: (c = 0xe8e2cc): WS => ({ c, r: 0.5, m: 0, w: 0.05, f: F.none }),
  /** Self-lit tritium or fibre-optic inserts. */
  glow: (c: number, e = 1.6): WS => ({ c, r: 0.3, m: 0, w: 0, e, f: F.none }),
  rust: (c = 0x6a3a1e): WS => ({ c, r: 0.9, m: 0.3, w: 1, f: F.none }),
  glass: (c = 0x0c1418): WS => ({ c, r: 0.05, m: 0.2, w: 0.05, f: F.none }),
};

/** A 2D point, with an optional fillet radius for the corner it makes. */
export type P2 = [number, number] | [number, number, number];

/**
 * The smallest fillet an outline's concave corners may have while it is being extruded with a bevel: the walls are the
 * outline pushed out by the bevel (the caps are the outline itself), and an inside corner tighter than that push folds the
 * wall over itself.
 */
let minFillet = 0;

function tracePath(p: THREE.Path, pts: P2[], outer = false) {
  const n = pts.length;
  const at = (i: number) => pts[(i + n) % n];
  for (let i = 0; i < n; i++) {
    const c = at(i);
    let r = c[2] ?? 0;
    if (outer && minFillet > 0) {
      // Only inside corners fold: a right turn on the counter-clockwise outline.
      const a = at(i - 1);
      const b = at(i + 1);
      const cross = (c[0] - a[0]) * (b[1] - c[1]) - (c[1] - a[1]) * (b[0] - c[0]);
      if (cross < 0) r = Math.max(r, minFillet);
    }
    if (r <= 0) {
      if (i === 0) p.moveTo(c[0], c[1]);
      else p.lineTo(c[0], c[1]);
      continue;
    }
    const a = at(i - 1);
    const b = at(i + 1);
    const la = Math.hypot(a[0] - c[0], a[1] - c[1]) || 1e-6;
    const lb = Math.hypot(b[0] - c[0], b[1] - c[1]) || 1e-6;
    const rr = Math.min(r, la * 0.5, lb * 0.5);
    const p0x = c[0] + ((a[0] - c[0]) / la) * rr;
    const p0y = c[1] + ((a[1] - c[1]) / la) * rr;
    const p1x = c[0] + ((b[0] - c[0]) / lb) * rr;
    const p1y = c[1] + ((b[1] - c[1]) / lb) * rr;
    if (i === 0) p.moveTo(p0x, p0y);
    else p.lineTo(p0x, p0y);
    p.quadraticCurveTo(c[0], c[1], p1x, p1y);
  }
  p.closePath();
}

/** An outline with rounded corners, and optional holes (outlines of their own, or circles). */
export function shape(pts: P2[], holes: (P2[] | { c: [number, number]; r: number })[] = []): THREE.Shape {
  const s = new THREE.Shape();
  tracePath(s, ccw(pts), true);
  for (const h of holes) {
    const p = new THREE.Path();
    if ('c' in h) p.absarc(h.c[0], h.c[1], h.r, 0, Math.PI * 2, true);
    else tracePath(p, cw(h));
    s.holes.push(p);
  }
  return s;
}

const area = (pts: P2[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};
const ccw = (pts: P2[]) => (area(pts) < 0 ? pts.slice().reverse() : pts);
const cw = (pts: P2[]) => (area(pts) > 0 ? pts.slice().reverse() : pts);

/** A rectangle (centre, size) with every corner rounded by `r`, as outline points. */
export const rrect = (cx: number, cy: number, w: number, h: number, r: number): P2[] => [
  [cx - w / 2, cy - h / 2, r],
  [cx + w / 2, cy - h / 2, r],
  [cx + w / 2, cy + h / 2, r],
  [cx - w / 2, cy + h / 2, r],
];

/** Points along a polyline, offset sideways (for a curved magazine's front and back faces). */
export function offsetLine(line: [number, number][], d: number): [number, number][] {
  return line.map((p, i) => {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / l) * d, p[1] + (dx / l) * d];
  });
}

// ------------------------------------------------------------------------------------------------ templates

type Metric = 'ext' | 'lathe' | 'box' | 'flat';

/**
 * Smooth normals within `crease` radians, hard edges past it, and the edge weight from them; re-indexed. Done here rather
 * than with three's `toCreasedNormals`, which hashes positions to the centimetre: far too coarse for parts a few
 * millimetres across.
 */
function finishGeo(src: THREE.BufferGeometry, crease: number, metric: Metric): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src;
  const P = g.attributes.position.array as ArrayLike<number>;
  const corners = P.length / 3;
  const faces = Math.floor(corners / 3);
  const fn = new Float64Array(faces * 3);
  const fa = new Float64Array(faces);
  const keep = new Uint8Array(faces);
  for (let f = 0; f < faces; f++) {
    const i = f * 9;
    const ux = P[i + 3] - P[i];
    const uy = P[i + 4] - P[i + 1];
    const uz = P[i + 5] - P[i + 2];
    const vx = P[i + 6] - P[i];
    const vy = P[i + 7] - P[i + 1];
    const vz = P[i + 8] - P[i + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-14) continue;
    keep[f] = 1;
    fa[f] = l;
    fn[f * 3] = nx / l;
    fn[f * 3 + 1] = ny / l;
    fn[f * 3 + 2] = nz / l;
  }
  // Corners at one spot, by a key to the hundredth of a millimetre.
  const q = (v: number) => Math.round(v * 1e5);
  const ids = new Map<string, number>();
  const pid = new Int32Array(corners);
  for (let c = 0; c < corners; c++) {
    const k = `${q(P[c * 3])},${q(P[c * 3 + 1])},${q(P[c * 3 + 2])}`;
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    pid[c] = id;
  }
  const at: number[][] = Array.from({ length: ids.size }, () => []);
  for (let f = 0; f < faces; f++) if (keep[f]) for (let j = 0; j < 3; j++) at[pid[f * 3 + j]].push(f);
  const cosC = Math.cos(crease);
  const pos: number[] = [];
  const nor: number[] = [];
  const edge: number[] = [];
  const idx: number[] = [];
  const out = new Map<string, number>();
  for (let f = 0; f < faces; f++) {
    if (!keep[f]) continue;
    for (let j = 0; j < 3; j++) {
      const c = f * 3 + j;
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (const o of at[pid[c]]) {
        const d = fn[o * 3] * fn[f * 3] + fn[o * 3 + 1] * fn[f * 3 + 1] + fn[o * 3 + 2] * fn[f * 3 + 2];
        if (d < cosC) continue;
        nx += fn[o * 3] * fa[o];
        ny += fn[o * 3 + 1] * fa[o];
        nz += fn[o * 3 + 2] * fa[o];
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      const e = edgeOf(metric, nx, ny, nz);
      const k = `${pid[c]}|${Math.round(nx * 1e3)},${Math.round(ny * 1e3)},${Math.round(nz * 1e3)}`;
      let v = out.get(k);
      if (v === undefined) {
        v = pos.length / 3;
        out.set(k, v);
        pos.push(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]);
        nor.push(nx, ny, nz);
        edge.push(e);
      }
      idx.push(v);
    }
  }
  const r = new THREE.BufferGeometry();
  r.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  r.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  r.setAttribute('edge', new THREE.Float32BufferAttribute(edge, 1));
  r.setIndex(idx);
  return r;
}

/** How much a vertex with this (local) normal sits on a rounded edge, 0 to 1. */
function edgeOf(metric: Metric, x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let e = 0;
  if (metric === 'ext') e = 1 - Math.max(az, Math.hypot(x, y));
  else if (metric === 'lathe') e = 1 - Math.max(ay, Math.hypot(x, z));
  else if (metric === 'box') e = 1 - Math.max(ax, ay, az);
  return Math.min(1, Math.max(0, e * 3.4));
}

const tpl = new Map<string, THREE.BufferGeometry>();
function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = tpl.get(key);
  if (!g) {
    g = shared(make());
    g.userData.key = key;
    tpl.set(key, g);
  }
  return g;
}

/** Number of templates built so far (tests). */
export const templateCount = () => tpl.size;

const HALF = Math.PI / 2;

// ------------------------------------------------------------------------------------------------ the builder

/** Collects a weapon's parts, with their finishes and edges. */
export class WB {
  readonly b = new MeshBuilder();
  readonly hi: boolean;
  private wp: number[] = [];
  private part = 0;
  /** Triangles by part, for the budget tests and tuning. */
  readonly stats = new Map<string, number>();

  constructor(readonly lod: Lod) {
    this.hi = lod === 'hi';
    this.b.jitter = 0.012;
    this.b.roundSeg = this.hi ? 2 : 1;
  }

  /** Curve segments for an outline's fillets. */
  get cs() {
    return this.hi ? 4 : 1;
  }

  /** Segments round a lathe of radius `r` (a fat barrel gets more than a pin). */
  rs(r: number) {
    if (!this.hi) return r > 0.012 ? 8 : 6;
    return r > 0.02 ? 32 : r > 0.009 ? 24 : r > 0.004 ? 16 : 10;
  }

  private tag(v0: number, f: number, edge?: THREE.BufferAttribute, e0 = 0) {
    const seed = ((this.part++ * 0.6180339887) % 1) * 0.999;
    const n = this.b.vertexCount - v0;
    for (let i = 0; i < n; i++) this.wp.push(f, edge ? edge.getX(i) : e0, seed);
  }

  /** A finished template under a transform. */
  put(g: THREE.BufferGeometry, px: number, py: number, pz: number, m: WS, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const v0 = this.b.vertexCount;
    this.b.geo(g, px, py, pz, sx, sy, sz, m, rx, ry, rz);
    this.tag(v0, m.f, g.attributes.edge as THREE.BufferAttribute);
    const k = String(g.userData.key ?? 'geo').split(':').slice(0, 2).join(':');
    this.stats.set(k, (this.stats.get(k) ?? 0) + (g.index ? g.index.count : g.attributes.position.count) / 3);
    return this;
  }

  /** Whatever `fn` adds with the plain builder, tagged with the finish (and no edges). */
  raw(m: WS, fn: (b: MeshBuilder) => void, edge = 0) {
    const v0 = this.b.vertexCount;
    const i0 = this.b.idx.length;
    fn(this.b);
    this.tag(v0, m.f, undefined, edge);
    this.stats.set('raw', (this.stats.get('raw') ?? 0) + (this.b.idx.length - i0) / 3);
    return this;
  }

  private extrudeTpl(key: string, make: () => THREE.Shape, depth: number, bev: number) {
    const hi = this.hi;
    // A bevel under a millimetre does not show on a flat face: those edges stay sharp, and cost nothing.
    const bevel = bev >= 0.0008 && (hi || bev >= 0.003);
    const cs = this.cs;
    return cached(`x:${key}:${depth.toFixed(5)}:${bev.toFixed(5)}:${this.lod}`, () => {
      const segs = bevel ? (hi ? (bev >= 0.0025 ? 3 : bev >= 0.0015 ? 2 : 1) : 1) : 0;
      minFillet = bevel ? bev * 1.2 : 0;
      const sh = make();
      minFillet = 0;
      const eg = new THREE.ExtrudeGeometry(sh, {
        depth: Math.max(1e-4, depth - (bevel ? bev * 2 : 0)),
        bevelEnabled: bevel,
        bevelThickness: bev,
        bevelSize: bev,
        bevelOffset: 0,
        bevelSegments: segs,
        curveSegments: cs,
      });
      eg.translate(0, 0, -(depth - (bevel ? bev * 2 : 0)) / 2);
      eg.deleteAttribute('uv');
      return finishGeo(eg, 0.62, 'ext');
    });
  }

  /**
   * A side profile: an outline in the gun's (z, y) plane, extruded across the gun `w` wide, centred on `x`, its edges
   * rounded by `bev`. The outline is drawn in absolute weapon coordinates; it is the outline of the faces, and the rounded
   * edges stand out round it by `bev` (holes close in by as much).
   */
  side(key: string, make: () => THREE.Shape, x: number, w: number, bev: number, m: WS) {
    return this.put(this.extrudeTpl(`s:${key}`, make, w, bev), x, 0, 0, m, 0, -HALF, 0);
  }

  /** A cross-section: an outline in the gun's (x, y) plane, swept down the gun from `z0` to `z1`, the ends rounded by `bev`. */
  sec(key: string, make: () => THREE.Shape, z0: number, z1: number, bev: number, m: WS, x = 0, y = 0) {
    return this.put(this.extrudeTpl(`c:${key}`, make, Math.abs(z1 - z0), bev), x, y, (z0 + z1) / 2, m);
  }

  /** A top profile: an outline in the gun's (x, z) plane (x across, z along), extruded `h` tall about height `y`. */
  top(key: string, make: () => THREE.Shape, y: number, h: number, bev: number, m: WS) {
    return this.put(this.extrudeTpl(`t:${key}`, make, h, bev), 0, y, 0, m, HALF, 0, 0);
  }

  /**
   * A turned part about an axis along z through (x, y): the profile is (radius, z) pairs in order along the outline, z
   * absolute. A radius of 0 closes an end.
   */
  turn(key: string, prof: [number, number][], x: number, y: number, m: WS, seg?: number, crease = 0.7, z = 0) {
    const rmax = prof.reduce((a, p) => Math.max(a, p[0]), 0);
    const s = seg ?? this.rs(rmax);
    const g = cached(`l:${key}:${s}`, () => {
      const lg = new THREE.LatheGeometry(
        prof.map(([r, z]) => new THREE.Vector2(Math.max(0, r), z)),
        s,
      );
      lg.deleteAttribute('uv');
      return finishGeo(lg, crease, 'lathe');
    });
    // The lathe turns about its y: laid along z.
    return this.put(g, x, y, z, m, HALF, 0, 0);
  }

  /** A turned part on an axis from `a` to `b` (any direction), its profile (radius, t) with t 0 at `a` and 1 at `b`. */
  turnAlong(key: string, prof: [number, number][], a: [number, number, number], bb: [number, number, number], m: WS, seg?: number) {
    const len = Math.hypot(bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]);
    const rmax = prof.reduce((acc, p) => Math.max(acc, p[0]), 0);
    const s = seg ?? this.rs(rmax);
    const g = cached(`la:${key}:${s}`, () => {
      const lg = new THREE.LatheGeometry(
        prof.map(([r, t]) => new THREE.Vector2(Math.max(0, r), t)),
        s,
      );
      lg.deleteAttribute('uv');
      return finishGeo(lg, 0.7, 'lathe');
    });
    const dir = new THREE.Vector3(bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    return this.put(g, a[0], a[1], a[2], m, e.x, e.y, e.z, 1, len, 1);
  }

  /** A plain tube along z from `z0` to `z1` at (x, y), the ends chamfered by `ch`. */
  tube(x: number, y: number, z0: number, z1: number, r: number, m: WS, ch = 0.0006, seg?: number) {
    const c = Math.min(ch, r * 0.4, Math.abs(z1 - z0) * 0.3);
    const key = `tube:${r.toFixed(5)}:${(z1 - z0).toFixed(5)}:${c.toFixed(5)}`;
    const s = seg ?? this.rs(r);
    const g = cached(`l:${key}:${s}`, () => {
      const L = z1 - z0;
      const pts = c > 0 ? [[0, 0], [r - c, 0], [r, c], [r, L - c], [r - c, L], [0, L]] : [[0, 0], [r, 0], [r, L], [0, L]];
      const lg = new THREE.LatheGeometry(pts.map(([a, b]) => new THREE.Vector2(a, b)), s);
      lg.deleteAttribute('uv');
      return finishGeo(lg, 0.7, 'lathe');
    });
    return this.put(g, x, y, z0, m, HALF, 0, 0);
  }

  /** A tube with a bore: a barrel's end with its crown, the hole going in `depth` (its walls dark, see the shader's `hole`). */
  bored(x: number, y: number, z0: number, z1: number, r: number, bore: number, m: WS, depth = 0.02) {
    const L = z1 - z0;
    const c = Math.min(0.0006, r * 0.2);
    const d = Math.min(depth, L * 0.9);
    this.turn(`bored:${r}:${bore}:${L.toFixed(5)}:${d}`, [[0, 0], [r - c, 0], [r, c], [r, L - c], [r - c * 0.5, L], [bore + 0.0006, L], [bore, L - 0.0006], [bore, L - d], [0, L - d]], x, y, m, undefined, 0.7, z0);
    // The bore itself, a dark sleeve just inside so the hole reads black from any angle.
    if (this.hi) this.turn(`bore:${bore}:${d}`, [[bore * 0.98, 0], [bore * 0.98, d - 0.0007], [0, d - 0.0007]], x, y, M.hole(), this.hi ? 12 : 6, 0.7, z1 - d + 0.0002);
    return this;
  }

  /** A box with rounded edges. */
  rbox(x: number, y: number, z: number, sx: number, sy: number, sz: number, r: number, m: WS, rx = 0, ry = 0, rz = 0) {
    sx = Math.abs(sx);
    sy = Math.abs(sy);
    sz = Math.abs(sz);
    const rr = Math.min(r, sx / 2 - 1e-5, sy / 2 - 1e-5, sz / 2 - 1e-5);
    if (rr <= 0.00015) return this.raw(m, (b) => b.box(x, y, z, sx, sy, sz, m, rx, ry, rz));
    // Small rounds get one bevel segment (a chamfer), and in the light model they are plain boxes.
    if (!this.hi && rr < 0.003) return this.raw(m, (b) => b.box(x, y, z, sx, sy, sz, m, rx, ry, rz));
    const seg = this.hi && rr >= 0.002 ? 2 : 1;
    const g = cached(`rb:${sx.toFixed(5)}:${sy.toFixed(5)}:${sz.toFixed(5)}:${rr.toFixed(5)}:${seg}`, () => {
      const rb = new RoundedBoxGeometry(sx, sy, sz, seg, rr);
      rb.deleteAttribute('uv');
      const n = rb.attributes.normal;
      const e = new Float32Array(n.count);
      for (let i = 0; i < n.count; i++) e[i] = edgeOf('box', n.getX(i), n.getY(i), n.getZ(i));
      rb.setAttribute('edge', new THREE.BufferAttribute(e, 1));
      return rb;
    });
    return this.put(g, x, y, z, m, rx, ry, rz);
  }

  /** A sharp box. */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, m: WS, rx = 0, ry = 0, rz = 0) {
    return this.raw(m, (b) => b.box(x, y, z, sx, sy, sz, m, rx, ry, rz));
  }

  /** A rod between two points. */
  rod(a: [number, number, number], b: [number, number, number], r: number, m: WS, seg?: number) {
    return this.raw(m, (mb) => mb.rod(a[0], a[1], a[2], b[0], b[1], b[2], r, m, seg ?? (this.hi ? 12 : 6)));
  }

  /** A bent rod (wire, a sling loop) through points, with a ball at each bend. */
  wire(pts: [number, number, number][], r: number, m: WS) {
    const seg = this.hi ? 8 : 5;
    return this.raw(m, (b) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const c = pts[i + 1];
        b.rod(a[0], a[1], a[2], c[0], c[1], c[2], r, m, seg);
        if (i > 0) b.add('sphere', a[0], a[1], a[2], r * 2, r * 2, r * 2, m);
      }
    });
  }

  sphere(x: number, y: number, z: number, r: number, m: WS, sx = 1, sy = 1, sz = 1) {
    return this.raw(m, (b) => b.add(this.hi ? 'sphere16' : 'sphere', x, y, z, r * 2 * sx, r * 2 * sy, r * 2 * sz, m));
  }

  torus(x: number, y: number, z: number, R: number, r: number, m: WS, rx = 0, ry = 0, rz = 0) {
    return this.raw(m, (b) => b.torus(x, y, z, R, r, m, rx, ry, rz, this.hi ? 8 : 5, this.hi ? 24 : 12));
  }

  /**
   * A slotted screw head on a face, its axis `n` ('x' out of the left face, '-x' the right, 'y' up, '-y' down, 'z'
   * forward). Only in the close-up model.
   */
  screw(x: number, y: number, z: number, n: 'x' | '-x' | 'y' | '-y' | 'z' | '-z', r: number, m: WS, slot = true, spin = 0.6) {
    if (!this.hi) return this;
    const g = cached(`screw:${r.toFixed(5)}`, () => {
      const lg = new THREE.LatheGeometry([new THREE.Vector2(0, 0.0012), new THREE.Vector2(r * 0.55, 0.0011), new THREE.Vector2(r * 0.9, 0.0007), new THREE.Vector2(r, 0.0002), new THREE.Vector2(r, -0.0004), new THREE.Vector2(0, -0.0004)], 12);
      lg.deleteAttribute('uv');
      return finishGeo(lg, 0.7, 'lathe');
    });
    const rot: Record<string, [number, number, number]> = { x: [0, 0, -HALF], '-x': [0, 0, HALF], y: [0, 0, 0], '-y': [Math.PI, 0, 0], z: [HALF, 0, 0], '-z': [-HALF, 0, 0] };
    const [rx, ry, rz] = rot[n];
    this.put(g, x, y, z, m, rx, ry, rz);
    if (slot) {
      // The slot across the head, in the dark.
      const d = 0.0013;
      const o = { x: [d, 0, 0], '-x': [-d, 0, 0], y: [0, d, 0], '-y': [0, -d, 0], z: [0, 0, d], '-z': [0, 0, -d] }[n] as number[];
      const c = Math.cos(spin) * r * 1.7;
      const s = Math.sin(spin) * r * 1.7;
      const t = r * 0.28;
      if (n === 'x' || n === '-x') this.box(x + o[0] * 0.75, y, z, 0.0008, Math.abs(s) + t, Math.abs(c) + t, M.hole(), spin, 0, 0);
      else if (n === 'y' || n === '-y') this.box(x, y + o[1] * 0.75, z, Math.abs(c) + t, 0.0008, t, M.hole(), 0, spin, 0);
      else this.box(x, y, z + o[2] * 0.75, Math.abs(c) + t, t, 0.0008, M.hole(), 0, 0, spin);
    }
    return this;
  }

  /** A pin end flush in a side face (both sides of the gun), a plain disc a hair proud of the surface at |x| = `x`. */
  pin(x: number, y: number, z: number, r: number, m: WS) {
    if (!this.hi) return this;
    for (const s of [1, -1]) this.raw(m, (b) => b.cyl(s * (x + 0.0002), y, z, r * 2, 0.0008, r * 2, m, 0, 0, HALF, 10), 0.4);
    return this;
  }

  /**
   * A Picatinny rail along the top from `z0` to `z1`, its base at height `y` (the rail's crests 9.5 mm higher): the
   * dovetail and the cross slots every 10 mm. Low detail is one plain strip.
   */
  rail(key: string, x: number, y: number, z0: number, z1: number, m: WS, rot = 0) {
    const W = 0.0212;
    const base = (): THREE.Shape => shape([[-0.0105, 0], [0.0105, 0], [0.0105, 0.003], [0.0078, 0.0045], [-0.0078, 0.0045], [-0.0105, 0.003]]);
    const crest = (): THREE.Shape => shape([[-0.0078, 0.0044], [0.0078, 0.0044], [W / 2, 0.0068], [W / 2, 0.0082], [0.0088, 0.0095], [-0.0088, 0.0095], [-W / 2, 0.0082], [-W / 2, 0.0068]]);
    const put = (g: THREE.BufferGeometry, z: number) => this.put(g, x, y, z, m, 0, 0, rot);
    const L = z1 - z0;
    put(this.extrudeTpl(`rail.base:${key}`, base, L, 0.0006), (z0 + z1) / 2);
    if (!this.hi) {
      put(this.extrudeTpl(`rail.crest:${key}`, crest, L, 0.0006), (z0 + z1) / 2);
      return this;
    }
    const n = Math.max(1, Math.floor((L + 0.0048) / 0.01));
    const off = z0 + (L - (n * 0.01 - 0.0048)) / 2;
    const tooth = this.extrudeTpl('rail.tooth', crest, 0.0052, 0);
    for (let i = 0; i < n; i++) put(tooth, off + i * 0.01 + 0.0026);
    return this;
  }

  /** The finished geometry. */
  build(): THREE.BufferGeometry {
    const g = this.b.build();
    g.setAttribute('wpn', new THREE.Float32BufferAttribute(this.wp, 3));
    return g;
  }
}
