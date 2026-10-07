import * as THREE from 'three';
import { MeshBuilder, S, type ColorIn, type Surf } from './builder';
import { valueNoise2 } from '../core/noise';
import { crate, jerryCan } from './parts';
import { YARD_FIRE, YARD_NAR, YARD_SHELTER, shelterYard } from '../world/narYard';

/**
 * Nar's yard: the ruined scrap workshop on the salt flat where the story opens. Three bent box-section portal frames stand
 * across the work floor; torn sheets of rusted corrugated iron lie over them as a roof and hang down the left side as a
 * wall, with ragged holes cut right through (real geometry: every sheet is marched out of a tear field, so the sky shows
 * through). A corrugated fence closes the back, with the workbench and a little lean-to against it; the skip, sacks and
 * crate stand on the right; Nar's pallet bed and a cold fire are in the back right corner under the roof; a half tractor
 * tyre hangs from the frames; a dead tree and an ochre pyramid hut stand behind the fence.
 *
 * Frame as `world/narYard.ts`: metres, ground at y = 0, +Z out of the open front, +X to the left looking out. Static, one
 * merged builder, double-sided where it is thin. Gameplay spots (`YARD_CLEAR`) are kept free below head height.
 */

type V2 = [number, number];
type V3 = [number, number, number];
type Srf = [number, number, number, number];

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const _col = new THREE.Color();
/** A hex colour in the working (linear) space, as MeshBuilder stores it. */
function lin(hex: number): V3 {
  _col.set(hex);
  return [_col.r, _col.g, _col.b];
}
const mix3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const srfOf = (s: Surf): Srf => [s.r ?? 0.82, s.m ?? 0, s.w ?? 0.5, s.e ?? 0];

/** One flat convex polygon facing `face` (winding fixed up to match), fan-triangulated with its own flat normal. */
function poly(b: MeshBuilder, pts: V3[], cols: V3[], sf: Srf, face: V3) {
  const n = pts.length;
  if (n < 3) return;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % n];
    nx += (a[1] - c[1]) * (a[2] + c[2]);
    ny += (a[2] - c[2]) * (a[0] + c[0]);
    nz += (a[0] - c[0]) * (a[1] + c[1]);
  }
  const m = Math.hypot(nx, ny, nz);
  if (m < 1e-9) return;
  nx /= m;
  ny /= m;
  nz /= m;
  const flip = nx * face[0] + ny * face[1] + nz * face[2] < 0;
  if (flip) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const base = b.pos.length / 3;
  for (let k = 0; k < n; k++) {
    const i = flip ? n - 1 - k : k;
    b.pos.push(pts[i][0], pts[i][1], pts[i][2]);
    b.nor.push(nx, ny, nz);
    b.col.push(cols[i][0], cols[i][1], cols[i][2]);
    b.srf.push(sf[0], sf[1], sf[2], sf[3]);
    b.uv.push(0, 0);
  }
  for (let k = 1; k < n - 1; k++) b.idx.push(base, base + k, base + k + 1);
}

// ------------------------------------------------------------------------------------------ torn sheets

/** Rust palettes for the sheets: the dark roof iron, the fence's browner iron, the hut's ochre. */
interface Pal {
  base: number;
  dark: number;
  rust: number;
  hi: number;
  s: Srf;
}
const ROOF: Pal = { base: 0x3e2a1c, dark: 0x22170f, rust: 0x6a3c1e, hi: 0x9a5426, s: [0.88, 0.38, 0.9, 0] };
const FENCE: Pal = { base: 0x5a3a24, dark: 0x332215, rust: 0x8a4e26, hi: 0xa8642c, s: [0.84, 0.4, 0.85, 0] };
const OCHRE: Pal = { base: 0xb0702e, dark: 0x7a4422, rust: 0xc8843a, hi: 0xd89a4a, s: [0.8, 0.3, 0.7, 0] };

interface Hole {
  u: number;
  v: number;
  r: number;
  /** Stretch along u and v (a long horizontal tear has su > 1). */
  su?: number;
  sv?: number;
}

/**
 * A sheet of iron in its own (u, v) plane, mapped into the yard as o + U u + V v + N (relief). Corrugation ribs run along V
 * (one grid column per half pitch, so each cell is a flat facet). The outline and holes come from a signed tear field
 * marched over the grid; torn edges are jagged at every scale and curl back; `tear` is how far each edge (u = 0, u = w,
 * v = 0, v = h) is eaten in, 0 for a straight edge. Both faces are built, the back a shade darker.
 */
interface Sheet {
  seed: number;
  w: number;
  h: number;
  o: V3;
  U: V3;
  V: V3;
  N: V3;
  pal: Pal;
  pitch?: number;
  depth?: number;
  du?: number;
  dv?: number;
  tear?: [number, number, number, number];
  holes?: Hole[];
  /** Rust perforation, 0 none to 1 riddled. */
  rot?: number;
  /** Droop along -N between the u = 0 and u = w edges. */
  sag?: number;
  /** How far torn edges bend back along -N. */
  curl?: number;
  crumple?: number;
  bend?: (u: number, v: number) => number;
  /** Extra straight-edged cut-out (a doorway, a triangle): negative inside the cut. */
  mask?: (u: number, v: number) => number;
}

function sheet(b: MeshBuilder, s: Sheet) {
  const pitch = s.pitch ?? 0;
  const nu = pitch > 0 ? Math.max(2, Math.round(s.w / (pitch / 2))) : Math.max(1, Math.round(s.w / (s.du ?? 0.15)));
  const du = s.w / nu;
  const nv = Math.max(1, Math.round(s.h / (s.dv ?? 0.2)));
  const dv = s.h / nv;
  const depth = pitch > 0 ? (s.depth ?? 0.03) : 0;
  const tear = s.tear ?? [0, 0, 0, 0];
  const holes = s.holes ?? [];
  const sd = s.seed | 0;
  const nz = (x: number, y: number, k: number) => valueNoise2(x + k * 17.3, y - k * 9.1, sd * 31 + k);
  const rag = (t: number, k: number) => Math.max(0, 0.1 + 0.75 * nz(t * 1.3, k * 3.7, 1) + 0.45 * (nz(t * 5.7, k, 2) - 0.5) + 0.32 * (nz(t * 17, k, 3) - 0.5));
  const torn = (u: number, v: number) => {
    let d = 1e9;
    if (tear[0] > 0) d = Math.min(d, u - tear[0] * rag(v, 0));
    if (tear[1] > 0) d = Math.min(d, s.w - u - tear[1] * rag(v, 1));
    if (tear[2] > 0) d = Math.min(d, v - tear[2] * rag(u, 2));
    if (tear[3] > 0) d = Math.min(d, s.h - v - tear[3] * rag(u, 3));
    for (let k = 0; k < holes.length; k++) {
      const hl = holes[k];
      const su = hl.su ?? 1;
      const sv = hl.sv ?? 1;
      const wob = 1.05 * (nz(u * 1.5, v * 1.5, 10 + k) - 0.5) + 0.6 * (nz(u * 5, v * 5, 20 + k) - 0.5) + 0.42 * (nz(u * 14, v * 14, 30 + k) - 0.5);
      // Warp the plane round the hole so its outline wanders like a tear, not an ellipse.
      const wu = u + (nz(u * 2.2, v * 2.2, 70 + k) - 0.5) * hl.r * 1.3;
      const wv = v + (nz(u * 2.2 + 5, v * 2.2, 80 + k) - 0.5) * hl.r * 1.0;
      d = Math.min(d, Math.hypot((wu - hl.u) / su, (wv - hl.v) / sv) - hl.r * (1 + wob));
      // A second, smaller bite off to one side, so no hole is a round porthole.
      const th = (sd * 1.7 + k * 2.3) % (Math.PI * 2);
      const bu = hl.u + Math.cos(th) * hl.r * 0.75 * su;
      const bv = hl.v + Math.sin(th) * hl.r * 0.5 * sv;
      d = Math.min(d, Math.hypot((wu - bu) / su, (wv - bv) / sv) - hl.r * 0.55 * (1 + wob * 1.2));
    }
    if (s.rot) {
      const p = 0.65 * nz(u * 2.4, v * 2.4, 40) + 0.35 * nz(u * 8, v * 8, 41);
      d = Math.min(d, (1 - 0.32 * s.rot - p) * 0.8);
    }
    return d;
  };
  const straight = (u: number, v: number) => {
    let d = 1e9;
    if (!(tear[0] > 0)) d = Math.min(d, u);
    if (!(tear[1] > 0)) d = Math.min(d, s.w - u);
    if (!(tear[2] > 0)) d = Math.min(d, v);
    if (!(tear[3] > 0)) d = Math.min(d, s.h - v);
    if (s.mask) d = Math.min(d, s.mask(u, v));
    return d + 1e-5;
  };
  const field = (u: number, v: number) => Math.min(torn(u, v), straight(u, v));
  const corr = (u: number) => (depth ? depth * (Math.abs(((u / (2 * du)) % 1) * 2 - 1) - 0.5) : 0);
  const crumple = s.crumple ?? 0.03;
  const offAt = (u: number, v: number, t: number) => {
    let o = corr(u) + (nz(u * 0.9, v * 0.9, 50) - 0.5) * crumple * 2;
    if (s.sag) o -= s.sag * Math.sin(Math.PI * clamp01(u / s.w));
    if (s.bend) o += s.bend(u, v);
    if (s.curl && t < 0.35) {
      const k = 1 - Math.max(0, t) / 0.35;
      o -= s.curl * k * k;
    }
    return o;
  };
  const cB = lin(s.pal.base);
  const cD = lin(s.pal.dark);
  const cR = lin(s.pal.rust);
  const cH = lin(s.pal.hi);
  const colAt = (u: number, v: number, t: number): V3 => {
    const a = nz(u * 0.55, v * 0.55, 60);
    const c = nz(u * 2.2, v * 2.2, 61);
    const e = nz(u * 9, v * 9, 62);
    let col = mix3(cB, cR, sstep(0.45, 0.8, a * 0.7 + c * 0.3));
    col = mix3(col, cD, sstep(0.5, 0.85, c * 0.55 + e * 0.45) * 0.75);
    col = mix3(col, cD, sstep(0.6, 0.9, nz(u * 7, v * 0.35, 63)) * 0.5);
    if (t < 0.12) col = mix3(col, cH, (1 - Math.max(0, t) / 0.12) * 0.55);
    const k = 0.88 + e * 0.24;
    return [col[0] * k, col[1] * k, col[2] * k];
  };
  const at = (u: number, v: number, o: number): V3 => [
    s.o[0] + s.U[0] * u + s.V[0] * v + s.N[0] * o,
    s.o[1] + s.U[1] * u + s.V[1] * v + s.N[1] * o,
    s.o[2] + s.U[2] * u + s.V[2] * v + s.N[2] * o,
  ];
  const thick = 0.004;
  const back: V3 = [-s.N[0], -s.N[1], -s.N[2]];
  const emit = (pts: V2[]) => {
    const front: V3[] = [];
    const rear: V3[] = [];
    const cf: V3[] = [];
    const cb: V3[] = [];
    for (const [u, v] of pts) {
      const t = torn(u, v);
      const o = offAt(u, v, t);
      front.push(at(u, v, o));
      rear.push(at(u, v, o - thick));
      const c = colAt(u, v, t);
      cf.push(c);
      cb.push([c[0] * 0.72, c[1] * 0.7, c[2] * 0.68]);
    }
    poly(b, front, cf, s.pal.s, s.N);
    poly(b, rear, cb, s.pal.s, back);
  };
  const W = nu + 1;
  const F = new Float64Array(W * (nv + 1));
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) F[j * W + i] = field(i * du, j * dv);
  const cross = (p: V3, q: V3): V2 => {
    const t = p[2] / (p[2] - q[2]);
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  };
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const u0 = i * du;
      const u1 = u0 + du;
      const v0 = j * dv;
      const v1 = v0 + dv;
      const cs: V3[] = [
        [u0, v0, F[j * W + i]],
        [u1, v0, F[j * W + i + 1]],
        [u1, v1, F[(j + 1) * W + i + 1]],
        [u0, v1, F[(j + 1) * W + i]],
      ];
      const ins = cs.map((c) => c[2] >= 0);
      const n = ins.filter(Boolean).length;
      if (n === 0) continue;
      if (n === 4) {
        emit([[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
        continue;
      }
      // Saddle: two opposite corners solid. Joined through the middle unless the centre is open.
      if (n === 2 && ins[0] === ins[2] && cs[0][2] + cs[1][2] + cs[2][2] + cs[3][2] < 0) {
        for (let k = 0; k < 4; k++) {
          if (!ins[k]) continue;
          const p = cs[k];
          emit([[p[0], p[1]], cross(p, cs[(k + 1) % 4]), cross(cs[(k + 3) % 4], p)]);
        }
        continue;
      }
      const out: V2[] = [];
      for (let k = 0; k < 4; k++) {
        const p = cs[k];
        const q = cs[(k + 1) % 4];
        if (ins[k]) out.push([p[0], p[1]]);
        if (ins[k] !== ins[(k + 1) % 4]) out.push(cross(p, q));
      }
      emit(out);
    }
  }
}

// ------------------------------------------------------------------------------------------ small geometry helpers

const segGeo = new Map<string, THREE.BufferGeometry>();
/** A tapered round segment between two points (radii ra at a, rc at c), capped: limbs, posts, stakes. */
function seg(b: MeshBuilder, a: V3, c: V3, ra: number, rc: number, col: ColorIn, sides = 7) {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  const dz = c[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return;
  const key = `${Math.round(ra * 1000)}:${Math.round(rc * 1000)}:${sides}`;
  let g = segGeo.get(key);
  if (!g) {
    g = new THREE.CylinderGeometry(rc, ra, 1, sides, 1, false);
    segGeo.set(key, g);
  }
  b.geo(g, (a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2, 1, len, 1, col, Math.acos(Math.max(-1, Math.min(1, dy / len))), Math.atan2(dx, dz), 0);
}

/** A rope or cable from a to c, hanging `sag` below the straight line at its middle. */
function rope(b: MeshBuilder, a: V3, c: V3, sag: number, r = 0.012, col: ColorIn = S.cloth(0x9a8a66, 0.6), n = 6) {
  let p = a;
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const q: V3 = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t - Math.sin(Math.PI * t) * sag, a[2] + (c[2] - a[2]) * t];
    b.rod(p[0], p[1], p[2], q[0], q[1], q[2], r, col, 5);
    p = q;
  }
}

/**
 * A surface of revolution from a closed profile loop (r, y), counter-clockwise with the solid on its left, swept round the
 * Y axis from phi0 through phiLen: smooth normals, winding checked per quad.
 */
function revolve(b: MeshBuilder, prof: V2[], phi0: number, phiLen: number, steps: number, s: Surf) {
  const n = prof.length;
  const c = lin(s.c as number);
  const sf = srfOf(s);
  const sn: V2[] = [];
  for (let i = 0; i < n; i++) {
    const p = prof[(i + n - 1) % n];
    const q = prof[i];
    const r = prof[(i + 1) % n];
    const n1x = q[1] - p[1];
    const n1y = -(q[0] - p[0]);
    const n2x = r[1] - q[1];
    const n2y = -(r[0] - q[0]);
    const l1 = Math.hypot(n1x, n1y) || 1;
    const l2 = Math.hypot(n2x, n2y) || 1;
    const x = n1x / l1 + n2x / l2;
    const y = n1y / l1 + n2y / l2;
    const l = Math.hypot(x, y) || 1;
    sn.push([x / l, y / l]);
  }
  const base = b.pos.length / 3;
  for (let j = 0; j <= steps; j++) {
    const ph = phi0 + (phiLen * j) / steps;
    const sp = Math.sin(ph);
    const cp = Math.cos(ph);
    for (let i = 0; i < n; i++) {
      b.pos.push(prof[i][0] * sp, prof[i][1], prof[i][0] * cp);
      b.nor.push(sn[i][0] * sp, sn[i][1], sn[i][0] * cp);
      b.col.push(c[0], c[1], c[2]);
      b.srf.push(sf[0], sf[1], sf[2], sf[3]);
      b.uv.push(0, 0);
    }
  }
  const P = (k: number) => [b.pos[(base + k) * 3], b.pos[(base + k) * 3 + 1], b.pos[(base + k) * 3 + 2]];
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * n + i;
      const bb = j * n + ((i + 1) % n);
      const cc = (j + 1) * n + ((i + 1) % n);
      const d = (j + 1) * n + i;
      const pa = P(a);
      const pb = P(bb);
      const pd = P(d);
      const ux = pb[0] - pa[0];
      const uy = pb[1] - pa[1];
      const uz = pb[2] - pa[2];
      const vx = pd[0] - pa[0];
      const vy = pd[1] - pa[1];
      const vz = pd[2] - pa[2];
      const gx = uy * vz - uz * vy;
      const gy = uz * vx - ux * vz;
      const gz = ux * vy - uy * vx;
      const na = (base + a) * 3;
      const dot = gx * b.nor[na] + gy * b.nor[na + 1] + gz * b.nor[na + 2];
      if (dot >= 0) b.idx.push(base + a, base + bb, base + cc, base + a, base + cc, base + d);
      else b.idx.push(base + a, base + cc, base + bb, base + a, base + d, base + cc);
    }
  }
}

/**
 * A soft sheet (blanket, rag) as a grid of `nu` by `nv` cells over a parametric surface, smooth normals from the grid,
 * both faces (the back pushed `thick` behind).
 */
function cloth(b: MeshBuilder, nu: number, nv: number, fn: (u: number, v: number) => V3, colFn: (u: number, v: number) => V3, s: Surf, thick = 0.006) {
  const sf = srfOf(s);
  const P: V3[] = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) P.push(fn(i / nu, j / nv));
  const W = nu + 1;
  const N: V3[] = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const a = P[j * W + Math.min(nu, i + 1)];
      const c = P[j * W + Math.max(0, i - 1)];
      const d = P[Math.min(nv, j + 1) * W + i];
      const e = P[Math.max(0, j - 1) * W + i];
      const ux = a[0] - c[0];
      const uy = a[1] - c[1];
      const uz = a[2] - c[2];
      const vx = d[0] - e[0];
      const vy = d[1] - e[1];
      const vz = d[2] - e[2];
      let x = uy * vz - uz * vy;
      let y = uz * vx - ux * vz;
      let z = ux * vy - uy * vx;
      const l = Math.hypot(x, y, z) || 1;
      x /= l;
      y /= l;
      z /= l;
      N.push([x, y, z]);
    }
  }
  for (const side of [1, -1]) {
    const base = b.pos.length / 3;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const p = P[j * W + i];
        const n = N[j * W + i];
        const k = side > 0 ? 0 : thick;
        b.pos.push(p[0] - n[0] * k, p[1] - n[1] * k, p[2] - n[2] * k);
        b.nor.push(n[0] * side, n[1] * side, n[2] * side);
        const c = colFn(i / nu, j / nv);
        const dk = side > 0 ? 1 : 0.75;
        b.col.push(c[0] * dk, c[1] * dk, c[2] * dk);
        b.srf.push(sf[0], sf[1], sf[2], sf[3]);
        b.uv.push(0, 0);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * W + i;
        const q = a + 1;
        const c = a + W + 1;
        const d = a + W;
        // The grid's own winding faces along u x v; the back side is wound the other way.
        if (side > 0) b.idx.push(a, q, c, a, c, d);
        else b.idx.push(a, c, q, a, d, c);
      }
    }
  }
}

/** An oil drum, base centre at (x, y, z): a can with two rolled hoops and a bung; `lie` lays it down along +Z. */
function oilDrum(b: MeshBuilder, x: number, y: number, z: number, c: Surf, lie = false) {
  const t = new MeshBuilder();
  t.cyl(0, 0.44, 0, 0.58, 0.88, 0.58, c, 0, 0, 0, 14);
  for (const hy of [0.29, 0.59]) t.cyl(0, hy, 0, 0.605, 0.025, 0.605, c, 0, 0, 0, 14);
  t.cyl(0.15, 0.885, 0.05, 0.06, 0.014, 0.06, S.steel(0x4a4440, 0.8), 0, 0, 0, 6);
  b.appendMatrix(t, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(lie ? Math.PI / 2 : 0, 0, 0)), new THREE.Vector3(1, 1, 1)));
}

/** An old tyre on a steel rim, lying flat (or stood up `stand` radians about X, then turned `yaw`). Centre at (x, y, z). */
function oldTyre(b: MeshBuilder, x: number, y: number, z: number, radius: number, width: number, stand = 0, yaw = 0) {
  const t = new MeshBuilder();
  t.torus(0, 0, 0, radius - width * 0.45, width * 0.5, S.rubber(0x1d1d1f), Math.PI / 2, 0, 0, 6, 18);
  t.cyl(0, 0, 0, radius * 1.2, width * 0.55, radius * 1.2, S.steel(0x55585b, 0.75), 0, 0, 0, 12);
  t.cyl(0, 0, 0, radius * 0.35, width * 0.6, radius * 0.35, S.steel(0x3a3c3e, 0.8), 0, 0, 0, 8);
  b.appendMatrix(t, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(stand, yaw, 0, 'YXZ')), new THREE.Vector3(1, 1, 1)));
}

// ------------------------------------------------------------------------------------------ the layout

/**
 * The three portal frames stand across the floor at these z: box tube bent into a tall coffin shape, the legs leaning out
 * from narrow feet (+-FOOT_X) to wide shoulders, the rafters bent in again to a wide flat top.
 */
const FRAME_Z = [-4.2, -0.9, 2.4];
const FOOT_X = 5.3;
const SH_X = 5.95;
const SH_Y = 2.6;
const TOP_X = 3.3;
const TOP_Y = 4.46;
const TW = 0.18;
const TD = 0.12;
/** Up-slope direction of the left (+X) roof pitch and its outward normal; the right pitch mirrors them. */
const SL = Math.hypot(SH_X - TOP_X, TOP_Y - SH_Y);
const SV: V2 = [(TOP_X - SH_X) / SL, (TOP_Y - SH_Y) / SL];
const SN: V2 = [SV[1], -SV[0]];
/** How far out a leg's centreline is at height y. */
const legX = (y: number) => FOOT_X + ((SH_X - FOOT_X) * (y + 0.04)) / (SH_Y + 0.04);
/** Height of a rafter's centreline above a point x on the left pitch (|x| between TOP_X and SH_X). */
const rafterY = (x: number) => SH_Y + ((SH_X - Math.abs(x)) / (SH_X - TOP_X)) * (TOP_Y - SH_Y);

const FENCE_Z = -4.95;
const FENCE_X0 = -6.62;
const FENCE_X1 = 6.06;
const SIDE_Z1 = -1.55;
const WALL_X = SH_X + TW / 2 + 0.12;
/** The workbench against the fence. Its top is exactly `top` high: the dog food can stands on it (`YARD_ITEMS`). */
const BENCH = { x0: -1.6, x1: 1.2, z0: -4.75, z1: -4.0, top: 0.92 };
const FIRE: V2 = [-2.65, -3.75];
// The big rusty skip stands right beside Nar's bed, on the garage side of it (as in the old game).
const SKIP = { x: -7.6, z: 1.0 };
const SWING = { x: 4.6, z: -3.3, y: 1.38 };
const TREE: V2 = [3.5, -6.6];
/** Centre height of the swing beam, tucked under the left rafters of the back two frames. */
const swingBeamY = () => rafterY(SWING.x) - TW / 2 / Math.abs(SV[0]) - 0.06;
const HUT = { x: -4.6, z: -7.1, half: 1.3, apex: 3.0 };

// ------------------------------------------------------------------------------------------ pieces

function frames(b: MeshBuilder, r: () => number) {
  const tube: Surf = { c: 0x7a4c28, r: 0.78, m: 0.5, w: 0.85 };
  const tube2: Surf = { c: 0x6c4226, r: 0.82, m: 0.45, w: 0.9 };
  const plateS = S.rust(0x5a3420);
  FRAME_Z.forEach((z, k) => {
    const pts: V2[] = [
      [-FOOT_X, -0.04],
      [-SH_X + (r() - 0.5) * 0.06, SH_Y + (r() - 0.5) * 0.05],
      [-TOP_X + (r() - 0.5) * 0.05, TOP_Y + (r() - 0.5) * 0.03],
      [TOP_X + (r() - 0.5) * 0.05, TOP_Y + (r() - 0.5) * 0.03],
      [SH_X + (r() - 0.5) * 0.06, SH_Y + (r() - 0.5) * 0.05],
      [FOOT_X, -0.04],
    ];
    // The middle frame took a knock: its top is dented in off centre. The front one's right shoulder is bent out.
    if (k === 1) pts.splice(3, 0, [0.5, TOP_Y - 0.13]);
    if (k === 2) {
      pts[1][0] -= 0.1;
      pts[1][1] -= 0.07;
    }
    const c = k === 1 ? tube2 : tube;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const q = pts[i + 1];
      const len = Math.hypot(q[0] - a[0], q[1] - a[1]);
      b.box((a[0] + q[0]) / 2, (a[1] + q[1]) / 2, z, len + TW * 0.92, TW, TD, c, 0, 0, Math.atan2(q[1] - a[1], q[0] - a[0]));
    }
    // Welded gussets at the bends, foot plates bolted down.
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i];
      for (const sz of [1, -1]) b.box(p[0], p[1], z + sz * (TD / 2 + 0.006), 0.2, 0.2, 0.012, plateS, 0, 0, Math.PI / 4 + (r() - 0.5) * 0.3);
    }
    for (const sx of [-1, 1]) {
      b.box(sx * FOOT_X, 0.012, z, 0.32, 0.024, 0.28, plateS);
      for (const dx of [-0.11, 0.11]) for (const dz of [-0.09, 0.09]) b.cyl(sx * FOOT_X + dx, 0.03, z + dz, 0.03, 0.03, 0.03, S.steel(0x3a3634, 0.8), 0, 0, 0, 6);
    }
  });
  const z0 = FRAME_Z[0] - 0.32;
  const z1 = FRAME_Z[2] + 0.32;
  const zc = (z0 + z1) / 2;
  const L = z1 - z0;
  // The ridge: a box beam tied in under the flat tops, and the eave rails the side wall hangs from.
  b.box(0.02, TOP_Y - 0.14, zc, 0.12, 0.12, L, tube2);
  for (const sx of [-1, 1]) b.box(sx * (SH_X + TW / 2 + 0.05), SH_Y - 0.1, zc, 0.1, 0.1, L, tube2);
  // The swing beam under the left rafters of the back two frames.
  const sy = swingBeamY();
  b.box(SWING.x, sy, (FRAME_Z[0] + FRAME_Z[1]) / 2, 0.1, 0.12, FRAME_Z[1] - FRAME_Z[0] + 0.32, tube2);
  for (const z of [FRAME_Z[0], FRAME_Z[1]]) b.box(SWING.x, sy + 0.1, z + (z < -2 ? 0.08 : -0.08), 0.12, 0.2, 0.02, plateS);
}

function roof(b: MeshBuilder, seed: number) {
  const z0 = FRAME_Z[0] - 0.25;
  const bay = [
    { z: z0, w: FRAME_Z[1] - z0 + 0.1 },
    { z: FRAME_Z[1] - 0.12, w: FRAME_Z[2] - FRAME_Z[1] + 0.42 },
  ];
  const off = TW / 2 + 0.03;
  // The front bay's sheets lap over the back bay's at the middle frame, a couple of centimetres higher.
  const lap = (z: number) => (z > FRAME_Z[1] - 0.5 ? 0.025 : 0);
  const slopeO = (sx: number, z: number): V3 => [sx * (SH_X + SN[0] * (off + lap(z)) - SV[0] * 0.15), SH_Y + SN[1] * (off + lap(z)) - SV[1] * 0.15, z];
  const slopeV = (sx: number): V3 => [sx * SV[0], SV[1], 0];
  const slopeN = (sx: number): V3 => [sx * SN[0], SN[1], 0];
  const sh = SL + 0.2;
  const corr = { pitch: 0.2, depth: 0.035, dv: 0.16, pal: ROOF, U: [0, 0, 1] as V3 };
  // Left pitch, back bay: two big holes, a ragged eave.
  sheet(b, { ...corr, seed: seed + 1, w: bay[0].w, h: sh, o: slopeO(1, bay[0].z), V: slopeV(1), N: slopeN(1), tear: [0.22, 0.12, 0.35, 0.18], holes: [{ u: 1.25, v: 1.55, r: 0.55, su: 1.3 }, { u: 2.75, v: 2.95, r: 0.32 }], sag: 0.1, curl: 0.06, rot: 0.3 });
  // Left pitch, front bay: torn back from the front and the top, one long hole.
  sheet(b, { ...corr, seed: seed + 2, w: bay[1].w, h: sh, o: slopeO(1, bay[1].z), V: slopeV(1), N: slopeN(1), tear: [0.1, 0.65, 0.3, 0.95], holes: [{ u: 2.0, v: 1.5, r: 0.62, su: 1.5, sv: 0.8 }], sag: 0.12, curl: 0.07, rot: 0.35 });
  // The flat top: the back bay mostly whole, the front bay a ragged fragment over the left.
  const topO = (z: number): V3 => [TOP_X + 0.15, TOP_Y + off + lap(z), z];
  sheet(b, { ...corr, seed: seed + 3, w: bay[0].w, h: TOP_X * 2 + 0.3, o: topO(bay[0].z), V: [-1, 0, 0], N: [0, 1, 0], tear: [0.15, 0.4, 0.2, 0.25], holes: [{ u: 1.9, v: 3.9, r: 0.8, su: 1.3 }, { u: 0.8, v: 1.4, r: 0.36, su: 1.5 }, { u: 2.6, v: 5.8, r: 0.3 }], sag: 0.12, curl: 0.06, rot: 0.25 });
  sheet(b, { ...corr, seed: seed + 4, w: bay[1].w, h: TOP_X * 2 + 0.3, o: topO(bay[1].z), V: [-1, 0, 0], N: [0, 1, 0], tear: [0.3, 1.5, 0.25, 2.9], holes: [{ u: 1.4, v: 1.7, r: 0.55, su: 1.4 }], sag: 0.1, curl: 0.08, rot: 0.35 });
  // Right pitch, back bay over Nar's bed: the soundest sheet in the yard. Front bay: only a strip at the top is left.
  sheet(b, { ...corr, seed: seed + 5, w: bay[0].w, h: sh, o: slopeO(-1, bay[0].z), V: slopeV(-1), N: slopeN(-1), tear: [0.2, 0.25, 0.25, 0.12], holes: [{ u: 0.6, v: 2.9, r: 0.28 }], sag: 0.1, curl: 0.05, rot: 0.2 });
  sheet(b, { ...corr, seed: seed + 6, w: bay[1].w, h: sh, o: slopeO(-1, bay[1].z), V: slopeV(-1), N: slopeN(-1), tear: [0.2, 0.8, 2.4, 0.1], holes: [{ u: 1.2, v: 3.1, r: 0.3 }], sag: 0.06, curl: 0.08, rot: 0.3 });
  // A torn flap hanging down inside from the right top corner in the front bay, and a torn piece hanging off each of the
  // front frame's rafters.
  sheet(b, { ...corr, seed: seed + 7, w: 1.5, h: 1.35, o: [-TOP_X - 0.05, TOP_Y + 0.02, 0.2], V: [-0.3, -0.954, 0], N: [-0.954, 0.3, 0], tear: [0.15, 0.2, 0, 0.45], holes: [{ u: 0.7, v: 0.8, r: 0.22 }], curl: 0.05, rot: 0.4 });
  const hx = 4.95;
  sheet(b, { ...corr, seed: seed + 9, w: 1.75, h: 1.2, o: [-TOP_X - 0.05, TOP_Y - 0.02, FRAME_Z[2] + TD / 2 + 0.03], U: [SV[0], -SV[1], 0], V: [-0.12, -0.99, 0], N: [0, 0, 1], tear: [0.15, 0.25, 0, 0.5], holes: [{ u: 0.8, v: 0.5, r: 0.22, su: 1.5 }], curl: 0.04, rot: 0.3 });
  sheet(b, { ...corr, seed: seed + 8, w: 2.0, h: 1.25, o: [hx, rafterY(hx) - 0.02, FRAME_Z[2] + TD / 2 + 0.03], U: [SV[0], SV[1], 0], V: [0, -1, 0], N: [0, 0, 1], tear: [0.2, 0.3, 0, 0.55], holes: [{ u: 1.1, v: 0.55, r: 0.25, su: 1.6 }], curl: 0.04, rot: 0.5 });
}

/** The left side: three big torn sheets hung from the eave rail outside the legs, a steel rail along their foot on blocks. */
function sideWall(b: MeshBuilder, seed: number) {
  const top = SH_Y - 0.05;
  const h = top - 0.43;
  const pieces: { z: number; w: number; tear: [number, number, number, number]; holes: Hole[] }[] = [
    { z: FRAME_Z[0] - 0.18, w: 2.3, tear: [0.08, 0.1, 0.05, 0.22], holes: [{ u: 1.0, v: 0.75, r: 0.38, su: 1.9, sv: 0.6 }] },
    { z: FRAME_Z[0] + 2.0, w: 2.4, tear: [0.08, 0.1, 0.06, 0.3], holes: [{ u: 0.9, v: 1.15, r: 0.42, su: 2.0, sv: 0.65 }, { u: 2.0, v: 0.35, r: 0.2, su: 1.6 }] },
    { z: FRAME_Z[0] + 4.3, w: FRAME_Z[2] + 0.18 - (FRAME_Z[0] + 4.3), tear: [0.08, 0.35, 0.08, 0.28], holes: [{ u: 1.3, v: 0.7, r: 0.46, su: 1.8, sv: 0.55 }] },
  ];
  pieces.forEach((p, i) => {
    const x = WALL_X + (i % 2) * 0.016;
    sheet(b, { seed: seed + 20 + i, pal: ROOF, pitch: 0.2, depth: 0.035, dv: 0.2, w: p.w, h, o: [x, top, p.z], U: [0, 0, 1], V: [0, -1, 0], N: [-1, 0, 0], tear: p.tear, holes: p.holes, curl: 0.05, rot: 0.25, bend: (u, v) => 0.07 * Math.sin((Math.PI * u) / p.w) * (v / h) });
  });
  const rail = S.steel(0x2e2622, 0.85);
  const z0 = FRAME_Z[0] - 0.18;
  const z1 = FRAME_Z[2] + 0.18;
  b.box(WALL_X - 0.03, 0.38, (z0 + z1) / 2, 0.07, 0.1, z1 - z0, rail);
  const wood = S.wood(0x8a5e2e, 0.6);
  for (const z of [-3.7, -1.0, 1.6]) b.box(WALL_X - 0.03, 0.165, z, 0.16, 0.33, 0.2, wood, 0, 0.1, 0);
  // Two loose blocks stood up by the wall.
  b.box(5.45, 0.2, -2.75, 0.2, 0.4, 0.24, S.wood(0xa06a32, 0.55), 0, 0.3, 0);
  b.box(5.5, 0.17, -3.95, 0.22, 0.34, 0.2, S.wood(0x96602c, 0.6), 0, -0.2, 0.06);
}

/** The back fence: vertical corrugated sheets of slightly different heights on wooden posts and rails; the short side run. */
function fence(b: MeshBuilder, seed: number, r: () => number) {
  const post = S.wood(0x5a4430, 0.6);
  const rail = S.wood(0x6a5034, 0.6);
  const runs: { a: V2; c: V2; N: V3 }[] = [
    { a: [FENCE_X0, FENCE_Z], c: [FENCE_X1, FENCE_Z], N: [0, 0, 1] },
    { a: [FENCE_X0, SIDE_Z1], c: [FENCE_X0, FENCE_Z], N: [1, 0, 0] },
  ];
  let k = 0;
  for (const run of runs) {
    const len = Math.hypot(run.c[0] - run.a[0], run.c[1] - run.a[1]);
    const ux = (run.c[0] - run.a[0]) / len;
    const uz = (run.c[1] - run.a[1]) / len;
    let t = 0;
    while (t < len - 0.05) {
      const w = Math.min(len - t, 0.82 + r() * 0.2);
      const h = 2.12 + r() * 0.22;
      const off = (k % 2 ? 0.014 : 0) - 0.01;
      const lean = (r() - 0.5) * 0.06;
      const tornTop = r() < 0.45 ? 0.1 + r() * 0.25 : 0;
      const holes: Hole[] = r() < 0.3 ? [{ u: w * (0.3 + r() * 0.4), v: 0.25 + r() * 0.4, r: 0.1 + r() * 0.12, su: 1.4 }] : [];
      sheet(b, {
        seed: seed + 100 + k,
        pal: FENCE,
        pitch: 0.15,
        depth: 0.026,
        dv: 0.3,
        w: w + 0.04,
        h,
        o: [run.a[0] + ux * (t - 0.02) - run.N[0] * off, -0.05, run.a[1] + uz * (t - 0.02) - run.N[2] * off],
        U: [ux, 0, uz],
        V: [0, 1, 0],
        N: run.N,
        tear: [0, 0, 0, tornTop],
        holes,
        rot: 0.8,
        crumple: 0.015,
        bend: (_u, v) => lean * v,
      });
      t += w;
      k++;
    }
    // Posts on the inner face every couple of metres, two rails.
    const n = Math.max(1, Math.round(len / 2.2));
    for (let i = 0; i <= n; i++) {
      const px = run.a[0] + ((run.c[0] - run.a[0]) * i) / n + run.N[0] * 0.08;
      const pz = run.a[1] + ((run.c[1] - run.a[1]) * i) / n + run.N[2] * 0.08;
      b.box(px, 1.15, pz, 0.1, 2.3, 0.1, post, 0, r() * 0.3, (r() - 0.5) * 0.03);
    }
    const alongX = Math.abs(run.N[2]) > 0.5;
    for (const y of [0.45, 1.85]) {
      const rx = (run.a[0] + run.c[0]) / 2 + run.N[0] * 0.15;
      const rz = (run.a[1] + run.c[1]) / 2 + run.N[2] * 0.15;
      b.box(rx, y, rz, alongX ? len + 0.08 : 0.05, 0.09, alongX ? 0.05 : len + 0.08, rail);
    }
  }
  // One tall post stands up out of the fence behind the bench: a rope runs from its top to the middle frame.
  b.box(2.4, 1.55, FENCE_Z + 0.08, 0.13, 3.1, 0.13, post, 0, 0.1, 0.02);
  rope(b, [2.4, 2.98, FENCE_Z + 0.1], [SH_X - 0.02, SH_Y + 0.04, FRAME_Z[1]], 0.12);
}

/** A sloped lean-to over the bench: one torn sheet from the fence top to a beam on two posts. */
function leanTo(b: MeshBuilder, seed: number) {
  const post = S.wood(0x5e4632, 0.6);
  const x0 = -1.95;
  const x1 = 1.6;
  const zf = -3.72;
  const yb = 2.12;
  for (const x of [-1.75, 1.35]) b.box(x, yb / 2, zf, 0.1, yb, 0.1, post, 0, 0.15, 0);
  b.box((x0 + x1) / 2, yb + 0.05, zf, x1 - x0, 0.1, 0.1, post);
  b.box((x0 + x1) / 2, 2.38, FENCE_Z + 0.16, x1 - x0, 0.08, 0.08, post);
  const dy = yb + 0.1 - 2.44;
  const dz = zf + 0.12 - (FENCE_Z - 0.05);
  const l = Math.hypot(dy, dz);
  const V: V3 = [0, dy / l, dz / l];
  sheet(b, { seed: seed + 40, pal: ROOF, pitch: 0.15, depth: 0.026, dv: 0.2, w: x1 - x0 + 0.1, h: l + 0.12, o: [x0 - 0.05, 2.44, FENCE_Z - 0.05], U: [1, 0, 0], V, N: [0, V[2], -V[1]], tear: [0.1, 0.35, 0.05, 0.4], holes: [{ u: 2.6, v: 0.75, r: 0.3 }], sag: 0.05, curl: 0.04, rot: 0.6 });
}

/** The workbench against the fence, a shelf above it, wheels, a battery, tins, boxes. Its top is exactly BENCH.top. */
function bench(b: MeshBuilder, r: () => number) {
  const { x0, x1, z0, z1, top } = BENCH;
  const xc = (x0 + x1) / 2;
  const plank = (c: number) => S.wood(c, 0.65);
  const n = 4;
  const pw = (z1 - z0) / n;
  for (let i = 0; i < n; i++) {
    const z = z0 + pw * (i + 0.5);
    b.box(xc, top - 0.02, z, x1 - x0, 0.04, pw - 0.006, plank([0x7a5a38, 0x6a4c30, 0x806040, 0x5e452c][i]));
  }
  const leg = S.wood(0x4e3a28, 0.65);
  for (const x of [x0 + 0.08, x1 - 0.08]) {
    for (const z of [z0 + 0.06, z1 - 0.06]) b.box(x, (top - 0.04) / 2, z, 0.08, top - 0.04, 0.08, leg);
    b.box(x, 0.25, (z0 + z1) / 2, 0.06, 0.06, z1 - z0 - 0.1, leg);
  }
  for (const z of [z0 + 0.06, z1 - 0.06]) b.box(xc, top - 0.1, z, x1 - x0 - 0.1, 0.1, 0.04, leg);
  // Lower shelf of loose boards.
  for (let i = 0; i < 3; i++) b.box(xc + (r() - 0.5) * 0.06, 0.29, z0 + 0.13 + i * 0.22, x1 - x0 - 0.2, 0.025, 0.18, plank(0x6a5034), 0, (r() - 0.5) * 0.04, 0);
  // The shelf on the fence above, on three brackets.
  const sz = FENCE_Z + 0.27;
  b.box(xc - 0.1, 1.55, sz, x1 - x0 - 0.3, 0.03, 0.26, plank(0x6e5236));
  for (const x of [x0 + 0.3, xc - 0.1, x1 - 0.4]) b.box(x, 1.46, FENCE_Z + 0.2, 0.04, 0.18, 0.2, S.steel(0x3e3632, 0.8));
  // Two old wheels stood on edge, leaning on each other against the fence.
  oldTyre(b, 0.45, top + 0.28, -4.38, 0.28, 0.16, Math.PI / 2, Math.PI / 2 + 0.08);
  oldTyre(b, 0.78, top + 0.27, -4.42, 0.27, 0.15, Math.PI / 2 - 0.12, Math.PI / 2 - 0.05);
  // A car battery, tins, a jar of bolts, a small crate, rags. The middle of the bench is left clear for the dog food.
  const bat = S.plastic(0x1e2022, 0.5);
  b.rbox(-1.28, top + 0.09, -4.42, 0.27, 0.18, 0.18, 0.012, bat, 0, 0.15, 0);
  for (const [dx, c] of [[-0.07, 0xb03020], [0.07, 0x2a2a2a]] as const) b.cyl(-1.28 + dx, top + 0.19, -4.42, 0.025, 0.03, 0.025, S.plastic(c, 0.4), 0, 0, 0, 6);
  const tins: [number, number, number, number][] = [
    [-0.9, -4.55, 0.11, 0x8a8a7a],
    [-0.8, -4.45, 0.08, 0x9a3a2a],
    [-0.95, -4.3, 0.13, 0x6a7a5a],
    [0.12, -4.62, 0.1, 0x7a7266],
  ];
  for (const [x, z, h, c] of tins) b.cyl(x, top + h / 2, z, 0.08, h, 0.08, S.metal(c, 0.7), 0, 0, 0, 8);
  b.cyl(-0.75, top + 0.08, -4.2, 0.1, 0.16, 0.1, S.glass(0x3a4030), 0, 0, 0, 8);
  crate(b, 0.08, top + 0.1, -4.3, 0.3, 0.2, 0.24, 0.3);
  b.box(-1.0, top + 0.012, -4.15, 0.3, 0.02, 0.2, S.cloth(0x4a5a6a, 0.7), 0, 0.5, 0);
  // On the shelf: tins, a jar, a coil of wire, a lamp.
  for (let i = 0; i < 5; i++) b.cyl(-1.2 + i * 0.26 + r() * 0.06, 1.565 + 0.06, sz + (r() - 0.5) * 0.08, 0.08, 0.12, 0.08, S.metal([0x7a6a58, 0x5a6a5a, 0x8a5a3a][i % 3], 0.75), 0, 0, 0, 8);
  b.torus(0.4, 1.6, sz, 0.09, 0.025, S.metal(0x8a6a4a, 0.6), Math.PI / 2, 0, 0, 5, 12);
  b.cyl(0.75, 1.65, sz, 0.12, 0.2, 0.12, S.metal(0x4a4a3a, 0.7), 0, 0, 0, 8);
  // Under it: a cardboard box and a bucket.
  b.box(-1.1, 0.42, -4.4, 0.36, 0.25, 0.32, S.paint(0x9a7448, 0.6), 0, 0.2, 0);
  b.cyl(0.7, 0.42, -4.35, 0.26, 0.24, 0.26, S.metal(0x6a6e6a, 0.7), 0, 0, 0, 10);
  // Tools hung on the fence beside the shelf.
  b.box(-1.75 + 0.3, 1.15, FENCE_Z + 0.06, 0.04, 0.3, 0.02, S.steel(0x4a4a48, 0.6), 0, 0, 0.2);
  b.box(1.0, 1.2, FENCE_Z + 0.06, 0.035, 0.34, 0.02, S.steel(0x5a5a58, 0.6), 0, 0, -0.15);
}

/** Nar's bed: a low pallet, a thin stained mattress (top at YARD_NAR.y), a pillow at the head (+X), the blanket thrown off. */
/** A box-section tube from a to c, both in one vertical plane of constant z: the lean-to's bent frames. */
function tubeZ(b: MeshBuilder, a: V2, c: V2, z: number, w: number, d: number, col: ColorIn) {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  b.box((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, z, Math.hypot(dx, dy) + w * 0.6, w, d, col, 0, 0, Math.atan2(dy, dx));
}

/**
 * Nar's lean-to, to the left of the garage: two small bent box-tube arches (the garage's coffin shape, cut down) under one
 * solid sheet of dark rusty iron, a torn rusty sheet hung down the open left side, and under it the pallet bed he lies on,
 * lengthwise, his head to the back. A black bag for a pillow and a wooden crate at his head, a rusty box by it; at his feet a
 * white jerrycan and a rusty tray (the oil can stands in it); a teal crate with a stick in it and a rusty bowl on top; a big
 * rusty tin at the front corner and a rope from the arch to a stake with two woven baskets hung on it.
 */
function narShelter(b: MeshBuilder, seed: number, r: () => number) {
  // Built in the lean-to's own frame (the middle of the pallet at the origin, his head to -z, the open foot end to +z), then
  // set down where it stands in the yard and turned as `YARD_SHELTER` says.
  const L = new MeshBuilder();
  L.seed(seed + 59);
  L.jitter = b.jitter;
  shelterLocal(L, seed, r);
  const at = shelterYard(0, 0);
  b.appendMatrix(L, new THREE.Matrix4().compose(new THREE.Vector3(at.x, 0, at.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), YARD_SHELTER.yaw), new THREE.Vector3(1, 1, 1)));
}

/** The lean-to in its own frame: see `narShelter`. */
function shelterLocal(b: MeshBuilder, seed: number, r: () => number) {
  const { x0, x1, z0, z1, top } = YARD_SHELTER;
  const py = YARD_NAR.y;
  const tube = S.rust(0x5a3220);
  const sh = 1.5;
  for (const az of [z0, z1]) {
    const pts: V2[] = [[x0, -0.02], [x0 + 0.06, sh], [x0 + 0.5, top], [x1 - 0.5, top], [x1 - 0.06, sh], [x1, -0.02]];
    for (let i = 0; i + 1 < pts.length; i++) tubeZ(b, pts[i], pts[i + 1], az, 0.1, 0.08, tube);
    // Foot plates.
    for (const fx of [x0, x1]) b.box(fx, 0.01, az, 0.2, 0.02, 0.2, S.steel(0x3a2c22, 0.9));
  }
  // Rails down the length: at the top corners and the shoulders.
  for (const [rx, ry] of [[x0 + 0.5, top], [x1 - 0.5, top], [x0 + 0.06, sh], [x1 - 0.06, sh]] as const) b.box(rx, ry, (z0 + z1) / 2, 0.06, 0.06, z1 - z0 + 0.1, tube);
  // The roof: one sheet of dark iron over the top, whole but for a rotten corner, sagging a little, tipped to one side.
  const tilt: V3 = [-0.997, 0.08, 0];
  sheet(b, { seed: seed + 60, pal: ROOF, pitch: 0.2, depth: 0.025, dv: 0.18, w: z1 - z0 + 0.5, h: x1 - x0 + 0.5, o: [x1 + 0.22, top + 0.08, z0 - 0.25], U: [0, 0, 1], V: tilt, N: [0.08, 0.997, 0], tear: [0.06, 0.08, 0.05, 0.1], holes: [{ u: 2.6, v: 0.35, r: 0.16 }], sag: 0.05, curl: 0.03, rot: 0.12 });
  // A torn rusty sheet hung down the left side, behind the legs.
  sheet(b, { seed: seed + 61, pal: FENCE, pitch: 0.2, depth: 0.03, dv: 0.2, w: 1.85, h: 1.45, o: [x0 - 0.17, 1.52, z0 + 0.07], U: [0, 0, 1], V: [0, -1, 0], N: [-1, 0, 0], tear: [0.1, 0.2, 0.05, 0.3], holes: [{ u: 1.3, v: 0.5, r: 0.18, su: 1.4 }], curl: 0.04, rot: 0.3 });
  // A worn patch of trodden ground under it.
  b.cyl(0, 0.008, 0.2, 1.45, 0.012, 1.7, S.concrete(0x9a8a70, 0.6), 0, 0, 0, 14);

  // The pallet: three runners down its length, pale boards lengthwise across them, a gap here and there.
  const runner = S.wood(0x6a5a44, 0.7);
  const board = S.wood(0xc6a676, 0.55);
  const len = 2.1;
  for (const dx of [-0.4, 0, 0.4]) b.box(dx, 0.035, 0.02, 0.08, 0.07, len, runner);
  for (let i = 0; i < 8; i++) {
    const bx = -0.42 + i * 0.12;
    b.box(bx, py - 0.012, 0.02 + (r() - 0.5) * 0.03, 0.105, 0.024, len - (i % 3 === 1 ? 0.06 : 0), board, 0, (r() - 0.5) * 0.01, 0);
  }
  // The pillow: a black bag stuffed under his head.
  const bag = new MeshBuilder();
  bag.rbox(0, 0, 0, 0.5, 0.16, 0.34, 0.07, S.cloth(0x1c1c1e, 0.4), 0, 0, 0, 2);
  bag.displace(0.025, 6, 41);
  b.appendMatrix(bag, new THREE.Matrix4().compose(new THREE.Vector3(0.02, py + 0.06, 0.03 - 0.92 + 0.1), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.15, 0.04)), new THREE.Vector3(1, 1, 1)));
  // At his head: a wooden crate on the left, a rusty box with a lid on the right.
  crate(b, -0.66, 0.23, z0 - 0.28, 0.6, 0.46, 0.48, 0.1);
  const rbox = S.rust(0x4a2c1c);
  b.box(0.68, 0.27, z0 - 0.2, 0.52, 0.54, 0.44, rbox, 0, -0.15, 0);
  b.box(0.66, 0.6, z0 - 0.08, 0.54, 0.03, 0.42, rbox, -0.55, -0.15, 0);
  // At his feet: a white plastic jerrycan, and the rusty tray the oil can stands in.
  jerryCan(b, 0.71, 0, 0.65, 0xe4e0d4, 0.25);
  const tray = S.rust(0x9a6a2a);
  const tx = 0.7;
  const tz = 1.72;
  b.box(tx, 0.015, tz, 0.62, 0.03, 0.5, tray, 0, 0.3, 0);
  const c3 = Math.cos(0.3);
  const s3 = Math.sin(0.3);
  for (const [lx, lz, sx, sz] of [[0.31, 0, 0.03, 0.5], [-0.31, 0, 0.03, 0.5], [0, 0.25, 0.62, 0.03], [0, -0.25, 0.62, 0.03]] as const) {
    b.box(tx + lx * c3 + lz * s3, 0.08, tz - lx * s3 + lz * c3, sx, 0.16, sz, tray, 0, 0.3, 0);
  }
  // A teal plastic crate beyond the tray, a stick standing in it and a rusty bowl on its rim.
  const teal = S.plastic(0x2f8a86, 0.45);
  const cx = 1.25;
  const cz = 2.55;
  b.box(cx, 0.02, cz, 0.56, 0.03, 0.4, teal);
  for (const sg of [-1, 1]) {
    b.box(cx + sg * 0.27, 0.17, cz, 0.025, 0.32, 0.4, teal);
    b.box(cx, 0.17, cz + sg * 0.19, 0.56, 0.32, 0.025, teal);
    for (let i = 0; i < 4; i++) b.box(cx - 0.18 + i * 0.12, 0.2, cz + sg * 0.205, 0.05, 0.14, 0.01, S.plastic(0x16403e, 0.5));
  }
  b.rod(cx - 0.15, 0.05, cz + 0.05, cx + 0.22, 0.42, cz - 0.08, 0.018, S.wood(0x8a7048, 0.7), 6);
  b.lathe('yardBowl', [[0, 0], [0.13, 0.01], [0.17, 0.07], [0.165, 0.075], [0.12, 0.02], [0, 0.015]], cx + 0.05, 0.335, cz, S.rust(0x8a4a22), 0, 0, 0, 12);
  // The big rusty tin at the front corner, its top rolled.
  const tin = S.rust(0x9a4a1e);
  b.cyl(-1.45, 0.31, 1.6, 0.54, 0.62, 0.54, tin, 0, 0, 0, 16);
  for (const hy of [0.12, 0.31, 0.5]) b.cyl(-1.45, hy, 1.6, 0.56, 0.025, 0.56, S.rust(0x7a3a18), 0, 0, 0, 16);
  b.cyl(-1.45, 0.615, 1.6, 0.5, 0.01, 0.5, S.rust(0x2a1810), 0, 0, 0, 16);
  // A rope from the front arch's corner down to a stake, two flat woven baskets hung on it.
  const ra: V3 = [x0 + 0.5, top - 0.04, z1];
  const rc: V3 = [-1.95, 0.12, 2.05];
  rope(b, ra, rc, 0.08, 0.01);
  b.rod(rc[0], -0.05, rc[2], rc[0] - 0.03, 0.24, rc[2] + 0.02, 0.022, S.wood(0x4a3a2a, 0.6), 6);
  const straw = S.cloth(0xc09a52, 0.55);
  for (const t of [0.42, 0.62]) {
    const px = ra[0] + (rc[0] - ra[0]) * t;
    const pyr = ra[1] + (rc[1] - ra[1]) * t - Math.sin(Math.PI * t) * 0.08;
    const pz = ra[2] + (rc[2] - ra[2]) * t;
    // Hung by a loop, the basket's face turned out to the yard.
    b.rod(px, pyr, pz, px, pyr - 0.12, pz, 0.006, S.cloth(0x7a6a4a, 0.6), 4);
    b.cyl(px, pyr - 0.34, pz, 0.24, 0.035, 0.24, straw, Math.PI / 2, 0.5, 0, 16);
    b.torus(px, pyr - 0.34, pz, 0.23, 0.02, S.cloth(0x9a7a3e, 0.6), Math.PI / 2, 0.5, 0, 4, 16);
  }
  // A plank leant on the left sheet, a small rusty bucket by the tin.
  b.box(-1.25, 0.72, 0.95, 0.24, 1.45, 0.03, S.wood(0x8a6a44, 0.7), 0.06, Math.PI / 2, 0.12);
  b.cyl(-1.0, 0.13, 2.1, 0.24, 0.26, 0.2, S.rust(0x6e4a2e), 0, 0, 0, 10);
}

/**
 * The cooking corner out in front of Nar's lean-to: a fire burning in a cut-down rusty drum (the flames themselves are
 * `game/story.ts`'s), a rack of rebar with torn sheet over it and cans hung from it, a rusty stove stood on its corner, a
 * pile of firewood and a sack.
 */
function cookingCorner(b: MeshBuilder, seed: number, r: () => number) {
  const { x: fx, z: fz } = YARD_FIRE;
  // The basin: half an oil drum, its rim ragged, ash and coals inside.
  const drum = S.rust(0x5e3420);
  b.lathe('yardFireBasin', [[0, 0.02], [0.4, 0.02], [0.43, 0.06], [0.45, 0.3], [0.41, 0.3], [0.39, 0.08], [0, 0.08]], fx, 0, fz, drum, 0, 0, 0, 16);
  b.cyl(fx, 0.12, fz, 0.76, 0.06, 0.76, S.concrete(0x2e2a28, 0.3), 0, 0, 0, 12);
  for (let i = 0; i < 6; i++) {
    const a = r() * Math.PI * 2;
    b.rod(fx + Math.cos(a) * 0.28, 0.14, fz + Math.sin(a) * 0.28, fx - Math.cos(a) * 0.05, 0.24, fz - Math.sin(a) * 0.05, 0.03, S.wood(0x1a120c, 0.4), 5);
  }
  for (let i = 0; i < 5; i++) b.add('ico1', fx + (r() - 0.5) * 0.3, 0.16, fz + (r() - 0.5) * 0.3, 0.06, 0.04, 0.06, S.glow(0xff6a1a, 2.2), r(), r(), 0);
  // Two bricks it stands on, and firewood stacked beside it.
  for (const s of [-1, 1]) b.box(fx + s * 0.25, 0.04, fz, 0.2, 0.08, 0.4, S.concrete(0x8a4a32, 0.6));
  for (let i = 0; i < 6; i++) b.cyl(fx + 0.85, 0.07 + (i % 3) * 0.12, fz - 0.25 + Math.floor(i / 3) * 0.12 + (r() - 0.5) * 0.04, 0.12, 0.7, 0.12, S.wood([0x6a4a2a, 0x7a5a36, 0x5a3e24][i % 3], 0.7), Math.PI / 2, 0, 0, 7);
  // The rebar rack: four bent bars stood in the ground, cross bars, torn sheet laid over the top, cans on wires.
  const rx = -11.6;
  const rz = 5.6;
  const bar = S.rust(0x5a2e1a);
  const legs: V2[] = [[-0.5, -0.45], [0.5, -0.45], [-0.5, 0.45], [0.5, 0.45]];
  for (const [lx, lz] of legs) seg(b, [rx + lx, -0.05, rz + lz], [rx + lx * 1.06, 3.0 + r() * 0.3, rz + lz * 1.04], 0.022, 0.018, bar, 6);
  for (const y of [1.15, 2.55]) {
    for (const [a, c] of [[0, 1], [2, 3], [0, 2], [1, 3]] as const) seg(b, [rx + legs[a][0], y, rz + legs[a][1]], [rx + legs[c][0], y + (r() - 0.5) * 0.06, rz + legs[c][1]], 0.016, 0.016, bar, 5);
  }
  seg(b, [rx + 0.55, 2.55, rz - 0.2], [rx + 0.85, 3.45, rz - 0.3], 0.016, 0.012, bar, 5);
  sheet(b, { seed: seed + 70, pal: FENCE, pitch: 0.2, depth: 0.03, dv: 0.2, w: 1.5, h: 1.3, o: [rx - 0.72, 2.6, rz - 0.62], U: [1, 0, 0.05], V: [0, -0.15, 0.99], N: [0, 0.99, 0.15], tear: [0.15, 0.35, 0.2, 0.5], holes: [{ u: 0.7, v: 0.6, r: 0.22, su: 1.5 }], curl: 0.08, rot: 0.4, sag: 0.08 });
  sheet(b, { seed: seed + 71, pal: ROOF, pitch: 0.2, depth: 0.03, dv: 0.2, w: 0.9, h: 1.1, o: [rx + 0.52, 2.5, rz - 0.4], U: [0, 0, 1], V: [0.1, -0.995, 0], N: [0.995, 0.1, 0], tear: [0.1, 0.3, 0, 0.45], holes: [{ u: 0.45, v: 0.5, r: 0.15 }], curl: 0.06, rot: 0.45 });
  for (const [cx2, cz2, h] of [[-0.25, 0.0, 0.5], [0.15, 0.2, 0.75], [0.3, -0.25, 0.4]] as const) {
    const top = 2.55;
    b.rod(rx + cx2, top, rz + cz2, rx + cx2, top - h, rz + cz2, 0.004, S.steel(0x3a3a3a), 4);
    b.cyl(rx + cx2, top - h - 0.13, rz + cz2, 0.18, 0.26, 0.18, S.rust([0x8a4a22, 0x6a3a1e, 0xa05a2a][Math.round(h * 10) % 3]), 0, 0, 0, 10);
  }
  // The stove: a rusty box stood up on one corner, its door hanging open, a pipe out of the top.
  const st = new MeshBuilder();
  st.box(0, 0, 0, 1.0, 1.0, 0.62, S.rust(0x6a3a20));
  st.box(0, 0, 0.315, 0.55, 0.55, 0.02, S.rust(0x2a1810));
  st.box(0.3, -0.05, 0.42, 0.5, 0.5, 0.025, S.rust(0x7a4422), 0, -1.1, 0);
  st.cyl(0.42, 0.42, 0, 0.16, 0.9, 0.16, S.rust(0x4a2a18), 0, 0, -Math.PI / 4, 10);
  b.appendMatrix(st, new THREE.Matrix4().compose(new THREE.Vector3(-11.9, 0.71, 7.3), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.35, Math.PI / 4, 'YXZ')), new THREE.Vector3(1, 1, 1)));
  // A white sack slumped against the rack.
  const sk = new MeshBuilder();
  sk.seed(seed + 72);
  sk.lathe('yardSack', SACK, 0, 0, 0, S.cloth(0xd8d2c4, 0.5), 0, 0, 0, 11);
  sk.displace(0.03, 4.2, 88);
  b.appendMatrix(sk, new THREE.Matrix4().compose(new THREE.Vector3(-10.75, 0, 6.35), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 1.1, -0.18, 'YXZ')), new THREE.Vector3(1.15, 1.0, 1.1)));
}

function tyreSwing(b: MeshBuilder) {
  const t = new MeshBuilder();
  const rub = S.rubber(0x1e1e1f);
  const prof: V2[] = [
    [0.46, -0.22], [0.6, -0.27], [0.72, -0.26], [0.79, -0.17], [0.81, 0], [0.79, 0.17], [0.72, 0.26], [0.6, 0.27], [0.46, 0.22],
    [0.48, 0.18], [0.61, 0.225], [0.71, 0.21], [0.755, 0.12], [0.765, 0], [0.755, -0.12], [0.71, -0.21], [0.61, -0.225], [0.48, -0.18],
  ];
  revolve(t, prof, Math.PI / 2, Math.PI, 14, rub);
  // Cut ends: the cross-section, solid.
  for (const sx of [1, -1]) {
    const sh = new THREE.Shape();
    prof.forEach(([pr, py], i) => (i ? sh.lineTo(sx * pr, py) : sh.moveTo(sx * pr, py)));
    sh.closePath();
    t.geo(new THREE.ShapeGeometry(sh), 0, 0, 0, 1, 1, 1, S.rubber(0x2a2a2a));
  }
  // Chevron lugs round the half tread.
  for (let i = 0; i < 11; i++) {
    const ph = Math.PI / 2 + ((i + 0.5) / 11) * Math.PI;
    for (const side of [-1, 1]) t.box(0.815 * Math.sin(ph), side * 0.12, 0.815 * Math.cos(ph), 0.07, 0.22, 0.05, rub, 0, ph, side * 0.55);
  }
  // Tyre axis along yard X, the half ring hanging below it; swung a touch.
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));
  const sw = new THREE.Matrix4().makeRotationX(0.06);
  const tr = new THREE.Matrix4().makeTranslation(SWING.x, SWING.y, SWING.z);
  b.appendMatrix(t, tr.multiply(sw).multiply(m));
  // Two ropes from holes in the ends up to the beam.
  const top = swingBeamY() - 0.06;
  const ca = Math.cos(0.06);
  const sa = Math.sin(0.06);
  for (const s of [-1, 1]) {
    const dz = s * 0.62;
    const end: V3 = [SWING.x, SWING.y + 0.02 * ca - dz * sa, SWING.z + 0.02 * sa + dz * ca];
    rope(b, end, [SWING.x, top, SWING.z + s * 0.22], 0, 0.016, S.cloth(0x8a7a5a, 0.7), 2);
    b.torus(end[0], end[1] + 0.03, end[2], 0.05, 0.012, S.steel(0x4a4440, 0.8), 0, Math.PI / 2, 0, 4, 10);
  }
}

/** The big open skip on the right: flared ends, ribbed sides, a rolled lip, scrap inside. */
function skip(b: MeshBuilder, r: () => number) {
  const { x, z } = SKIP;
  const rust = S.rust(0x6a3a22);
  const rust2: Surf = { c: 0x7a4a26, r: 0.85, m: 0.4, w: 0.95 };
  const hw = 0.85;
  const H = 1.3;
  const bot = 1.3;
  const tp = 1.85;
  b.box(x, 0.06, z, hw * 2, 0.08, bot * 2, rust);
  const side = () => {
    const s = new THREE.Shape();
    s.moveTo(-bot, 0.04);
    s.lineTo(bot, 0.04);
    s.lineTo(tp, H);
    s.lineTo(-tp, H);
    s.closePath();
    return s;
  };
  for (const sx of [-1, 1]) {
    b.extrude('yardSkipSide', side, 0.05, 0, x + sx * hw, 0, z, sx > 0 ? rust2 : rust, 0, -Math.PI / 2, 0);
    for (let i = 0; i < 5; i++) {
      const zz = z - 1.1 + i * 0.55;
      b.box(x + sx * (hw + 0.045), 0.62, zz, 0.05, 1.16, 0.08, rust);
    }
    b.box(x + sx * hw, H + 0.02, z, 0.09, 0.07, tp * 2 + 0.08, rust2);
    for (const e of [-1, 1]) b.cyl(x + sx * (hw + 0.09), 0.95, z + e * 1.25, 0.11, 0.1, 0.11, rust, 0, 0, Math.PI / 2, 8);
  }
  const ang = Math.atan2(tp - bot, H - 0.04);
  const el = Math.hypot(tp - bot, H - 0.04);
  for (const e of [-1, 1]) {
    b.box(x, 0.04 + (H - 0.04) / 2, z + e * (bot + tp) / 2, hw * 2 + 0.05, el, 0.05, rust, e * ang, 0, 0);
    b.box(x, H + 0.02, z + e * tp, hw * 2 + 0.1, 0.07, 0.09, rust2);
  }
  // Scrap inside: planks sticking up, a bent pipe, an old tyre.
  for (let i = 0; i < 3; i++) b.box(x + (r() - 0.5) * 0.9, 0.9, z + (r() - 0.5) * 1.6, 0.16, 1.5, 0.03, S.wood(0x7a6040, 0.7), (r() - 0.5) * 0.6, r() * 3, (r() - 0.5) * 0.7);
  b.pipe([[x - 0.5, 0.4, z - 0.6], [x + 0.2, 1.0, z - 0.3], [x + 0.35, 1.45, z + 0.3]], 0.04, S.rust(0x5a3420), 6);
  oldTyre(b, x + 0.2, 0.25, z + 0.7, 0.36, 0.2, 0.3, 0.4);
}

const SACK: V2[] = [[0, 0], [0.2, 0.0], [0.27, 0.06], [0.29, 0.2], [0.27, 0.36], [0.2, 0.46], [0.11, 0.52], [0.06, 0.555], [0.065, 0.6], [0.1, 0.665], [0.05, 0.7], [0, 0.705]];

/** Burlap sacks, tied at the neck, slumped against the skip. */
function sacks(b: MeshBuilder) {
  const list: { x: number; z: number; y: number; s: number; c: number; tilt: number; yaw: number }[] = [
    { x: -6.45, z: -0.25, y: 0, s: 1.05, c: 0x8a8274, tilt: 0.12, yaw: 0.3 },
    { x: -6.47, z: 0.2, y: 0, s: 1.0, c: 0x7e776a, tilt: 0.1, yaw: 1.4 },
    { x: -6.15, z: -0.05, y: 0, s: 0.74, c: 0xb0703a, tilt: -0.05, yaw: 2.2 },
    { x: -6.5, z: 0.0, y: 0.42, s: 0.82, c: 0xa8683a, tilt: 0.55, yaw: -0.4 },
  ];
  list.forEach((k, i) => {
    const t = new MeshBuilder();
    t.seed(31 + i);
    t.lathe('yardSack', SACK, 0, 0, 0, S.cloth(k.c, 0.6), 0, 0, 0, 11);
    t.displace(0.028, 4.2, 70 + i);
    t.torus(0, 0.585, 0, 0.068, 0.012, S.cloth(0x6a5a40, 0.6), Math.PI / 2, 0, 0, 4, 10);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(k.x, k.y, k.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, k.yaw, -k.tilt, 'YXZ')),
      new THREE.Vector3(k.s * 1.05, k.s * 0.92, k.s),
    );
    b.appendMatrix(t, m);
  });
}

/** Small things standing about: drums, the teal crate, the blue toolbox, a cardboard box, a tyre, planks. */
function clutter(b: MeshBuilder) {
  oilDrum(b, 1.65, 0, -4.48, S.rust(0x6e3a22));
  oilDrum(b, -6.2, 0.29, 4.0, S.paint(0x4a5a3a, 0.9), true);
  // The blue toolbox.
  const blue = S.paint(0x2f5a8a, 0.65);
  const tb = new MeshBuilder();
  tb.rbox(0, 0.1, 0, 0.52, 0.2, 0.24, 0.012, blue);
  tb.rbox(0, 0.22, 0, 0.53, 0.05, 0.25, 0.015, blue);
  tb.rod(-0.12, 0.27, 0, 0.12, 0.27, 0, 0.012, S.steel(0x2a2a2a), 5);
  for (const s of [-1, 1]) tb.rod(s * 0.12, 0.245, 0, s * 0.12, 0.27, 0, 0.01, S.steel(0x2a2a2a), 5);
  tb.box(0, 0.19, 0.128, 0.06, 0.05, 0.012, S.metal(0xb0a890, 0.4));
  b.appendMatrix(tb, new THREE.Matrix4().compose(new THREE.Vector3(3.15, 0, -4.45), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.12, 0)), new THREE.Vector3(1, 1, 1)));
  // Cardboard box in the corner behind the bed, flaps open.
  const card = S.paint(0x9a7448, 0.55);
  b.box(-5.55, 0.19, -4.45, 0.45, 0.38, 0.38, card, 0, 0.25, 0);
  b.box(-5.55 + 0.1, 0.42, -4.45 + 0.24, 0.42, 0.012, 0.16, card, 0.9, 0.25, 0);
  b.box(-5.55 - 0.1, 0.42, -4.45 - 0.24, 0.42, 0.012, 0.16, card, -0.7, 0.25, 0);
  // Old tyres: one lying on the floor, one leaning on the fence.
  oldTyre(b, -1.45, 0.1, -2.7, 0.33, 0.2, 0, 0.3);
  oldTyre(b, -3.6, 0.35, FENCE_Z + 0.25, 0.33, 0.2, Math.PI / 2 - 0.25, 0.1);
  // Planks dropped on the floor.
  const pl = (x: number, z: number, len: number, yaw: number, c: number) => b.box(x, 0.013, z, len, 0.025, 0.17, S.wood(c, 0.7), 0, yaw, 0);
  pl(2.05, -2.25, 1.3, 0.35, 0x7a5c3a);
  pl(-0.9, -3.0, 1.2, -0.2, 0x6a5034);
  pl(-0.82, -2.82, 1.1, -0.05, 0x806444);
  pl(3.1, 4.7, 1.6, 1.2, 0x705438);
  // A rusty bucket and a coil of rope out in front.
  b.cyl(3.0, 0.15, 4.4, 0.3, 0.3, 0.28, S.rust(0x6e4a2e), 0, 0, 0, 10);
  b.torus(-4.1, 0.03, 4.55, 0.18, 0.025, S.cloth(0x9a8a66, 0.6), Math.PI / 2, 0, 0, 5, 14);
  b.torus(-4.1, 0.07, 4.55, 0.15, 0.025, S.cloth(0x9a8a66, 0.6), Math.PI / 2, 0, 0, 5, 14);
}

/** Ropes: guys from the front frame's shoulders to stakes, a line between the right legs with a rag pegged on it. */
function ropes(b: MeshBuilder) {
  const stake = S.wood(0x4a3a2a, 0.6);
  for (const sx of [-1, 1]) {
    const st: V3 = [sx * 7.55, 0.12, 3.75];
    rope(b, [sx * (SH_X + 0.05), SH_Y + 0.05, FRAME_Z[2]], st, 0.06);
    b.rod(st[0], -0.05, st[2], st[0] + sx * 0.04, 0.22, st[2] + 0.02, 0.025, stake, 6);
  }
  const ly = 1.85;
  const lx = -legX(ly) + 0.02;
  rope(b, [lx, ly, FRAME_Z[0] + 0.06], [lx, ly, FRAME_Z[1] - 0.06], 0.1, 0.008);
  // A grey shirt hung to dry.
  const rag = lin(0x8a8a80);
  const z0 = -2.35;
  cloth(
    b,
    5,
    6,
    (u, v) => {
      const z = z0 + u * 0.48;
      const t = (z - (FRAME_Z[0] + 0.06)) / (FRAME_Z[1] - FRAME_Z[0] - 0.12);
      const y = ly - Math.sin(Math.PI * t) * 0.1 - v * 0.55;
      return [lx + Math.sin(u * 5 + v * 3) * 0.03 + v * 0.02, y, z + Math.sin(v * 4) * 0.015];
    },
    () => rag,
    S.cloth(0x8a8a80, 0.6),
  );
}

/** A hurricane lamp hung under the front frame's top. */
function lantern(b: MeshBuilder) {
  const x = -1.6;
  const z = FRAME_Z[2];
  const y = TOP_Y - TW / 2;
  b.rod(x, y, z, x, y - 0.95, z, 0.006, S.steel(0x3a3a3a), 4);
  const ly = y - 1.2;
  b.cyl(x, ly, z, 0.14, 0.03, 0.14, S.metal(0x5a4a3a, 0.7), 0, 0, 0, 8);
  b.cyl(x, ly + 0.1, z, 0.1, 0.16, 0.1, S.glass(0x6a5a3a), 0, 0, 0, 8);
  b.cyl(x, ly + 0.2, z, 0.12, 0.04, 0.12, S.metal(0x5a4a3a, 0.7), 0, 0, 0, 8);
  b.torus(x, ly + 0.25, z, 0.05, 0.006, S.steel(0x3a3a3a), 0, 0, 0, 4, 10);
}

/** The dead tree behind the fence: a grey, twisted trunk forking at head height into bare limbs, twigs at the ends. */
function deadTree(b: MeshBuilder, seed: number) {
  const r = rng(seed + 77);
  const bark = S.wood(0x847d70, 0.25);
  const old = S.wood(0x6e675c, 0.3);
  const [tx, tz] = TREE;
  const unit = (v: V3): V3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  /** d turned by `ang` toward a random side, leaning a little up and away from the yard (-Z). */
  const turn = (d: V3, ang: number): V3 => {
    const up: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const p1 = unit([d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]]);
    const p2: V3 = [d[1] * p1[2] - d[2] * p1[1], d[2] * p1[0] - d[0] * p1[2], d[0] * p1[1] - d[1] * p1[0]];
    const a = r() * Math.PI * 2;
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    return unit([d[0] * c + (p1[0] * Math.cos(a) + p2[0] * Math.sin(a)) * sn, d[1] * c + (p1[1] * Math.cos(a) + p2[1] * Math.sin(a)) * sn + 0.08, d[2] * c + (p1[2] * Math.cos(a) + p2[2] * Math.sin(a)) * sn - 0.12]);
  };
  const limb = (p: V3, d: V3, len: number, r0: number, r1: number, depth: number) => {
    const n = depth === 0 ? 3 : 2;
    let q = p;
    let dd = d;
    for (let i = 0; i < n; i++) {
      dd = turn(dd, (depth === 0 ? 0.16 : 0.22) * r());
      const e: V3 = [q[0] + (dd[0] * len) / n, q[1] + (dd[1] * len) / n, q[2] + (dd[2] * len) / n];
      // Keep the crown within 2.1 m of the trunk, and so inside the yard's bounds.
      const ox = e[0] - tx;
      const oz = e[2] - tz;
      const reach = Math.hypot(ox, oz);
      if (reach > 2.1) {
        e[0] = tx + (ox / reach) * 2.1;
        e[2] = tz + (oz / reach) * 2.1;
      }
      seg(b, q, e, r0 + ((r1 - r0) * i) / n, r0 + ((r1 - r0) * (i + 1)) / n, depth ? old : bark, depth === 0 ? 8 : depth === 1 ? 6 : 5);
      q = e;
    }
    if (depth === 3) return;
    const kids = depth === 2 ? 2 : 3;
    for (let k = 0; k < kids; k++) {
      // Now and then a limb snapped off short.
      const snapped = depth > 0 && r() < 0.2;
      limb(q, turn(dd, (depth === 0 ? 0.65 : 0.5) + r() * 0.35), len * (depth === 0 ? 0.56 : 0.6) * (0.85 + r() * 0.3) * (snapped ? 0.4 : 1), r1, r1 * 0.55, snapped ? 3 : depth + 1);
    }
  };
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + r();
    seg(b, [tx, 0.18, tz], [tx + Math.cos(a) * 0.55, -0.05, tz + Math.sin(a) * 0.55], 0.1, 0.03, bark, 5);
  }
  limb([tx, -0.05, tz], [0.1, 1, -0.06], 2.5, 0.24, 0.15, 0);
}

/** The ochre pyramid hut behind the fence: four corrugated faces to an apex, a doorway in the left face, hip strips. */
function hut(b: MeshBuilder, seed: number) {
  const { x, z, half, apex } = HUT;
  const c: V3[] = [
    [x - half, 0, z + half],
    [x + half, 0, z + half],
    [x + half, 0, z - half],
    [x - half, 0, z - half],
  ];
  const ap: V3 = [x, apex, z];
  const W = half * 2;
  for (let k = 0; k < 4; k++) {
    const a = c[k];
    const q = c[(k + 1) % 4];
    const U: V3 = [(q[0] - a[0]) / W, 0, (q[2] - a[2]) / W];
    const mid: V3 = [(a[0] + q[0]) / 2, 0, (a[2] + q[2]) / 2];
    const H = Math.hypot(ap[0] - mid[0], ap[1], ap[2] - mid[2]);
    const V: V3 = [(ap[0] - mid[0]) / H, ap[1] / H, (ap[2] - mid[2]) / H];
    let N: V3 = [U[1] * V[2] - U[2] * V[1], U[2] * V[0] - U[0] * V[2], U[0] * V[1] - U[1] * V[0]];
    if (N[0] * (mid[0] - x) + N[2] * (mid[2] - z) < 0) N = [-N[0], -N[1], -N[2]];
    const door = k === 1;
    sheet(b, {
      seed: seed + 60 + k,
      pal: OCHRE,
      pitch: 0.17,
      depth: 0.028,
      dv: 0.24,
      w: W,
      h: H,
      o: [a[0], -0.03, a[2]],
      U,
      V,
      N,
      tear: [0, 0, k === 2 ? 0.25 : 0, 0],
      holes: k === 3 ? [{ u: 0.9, v: 1.3, r: 0.22 }] : [],
      rot: 0.5,
      crumple: 0.015,
      mask: (u, v) => {
        const hw = (W / 2) * (1 - v / H);
        let m = Math.min(u - (W / 2 - hw), W / 2 + hw - u);
        if (door) m = Math.min(m, Math.max(Math.abs(u - W / 2) - 0.34, v - 1.3));
        return m;
      },
    });
  }
  const hip = S.rust(0x8a4a22);
  for (const p of c) b.rod(p[0], 0, p[2], ap[0], ap[1], ap[2], 0.035, hip, 5);
  b.add('cone6', ap[0], ap[1] + 0.06, ap[2], 0.22, 0.16, 0.22, hip);
  // A dark floor inside and a door plank leaning by the opening.
  b.box(x, 0.006, z, W - 0.1, 0.012, W - 0.1, S.concrete(0x2a2420, 0.6));
  b.box(x + half + 0.25, 0.85, z + 0.55, 0.05, 1.7, 0.55, S.wood(0x6a5034, 0.7), 0, 0.2, -0.16);
}

/** Flat patches of old concrete and trodden dirt under the workshop, 2 cm thick. */
function slabs(b: MeshBuilder, seed: number) {
  const r = rng(seed + 91);
  const patches: { x: number; z: number; rx: number; rz: number; y: number; c: number }[] = [
    { x: 0.2, z: -1.3, rx: 4.6, rz: 3.1, y: 0.02, c: 0x86684a },
    { x: -3.6, z: -2.9, rx: 1.4, rz: 1.1, y: 0.024, c: 0x6a5240 },
    { x: 3.7, z: -2.6, rx: 1.5, rz: 1.2, y: 0.016, c: 0x7c6248 },
    { x: -1.6, z: 2.6, rx: 1.3, rz: 0.9, y: 0.014, c: 0x806448 },
  ];
  patches.forEach((p, i) => {
    const pts: V2[] = [];
    const n = 16;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const w = 0.72 + r() * 0.4;
      pts.push([Math.cos(a) * p.rx * w, Math.sin(a) * p.rz * w]);
    }
    b.extrude(`narYardSlab:${seed}:${i}`, () => {
      const s = new THREE.Shape();
      pts.forEach(([u, v], k) => (k ? s.lineTo(u, v) : s.moveTo(u, v)));
      s.closePath();
      return s;
    }, p.y, 0, p.x, p.y / 2, p.z, S.concrete(p.c, 0.7), -Math.PI / 2, 0, 0);
  });
}

// ------------------------------------------------------------------------------------------ the whole yard

/** Nar's yard, built whole in the yard frame. Cache it: it is built once and appended where the yard stands. */
export function narYardModel(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.06;
  const r = rng(seed + 5);
  frames(b, r);
  roof(b, seed);
  sideWall(b, seed);
  fence(b, seed, r);
  leanTo(b, seed);
  bench(b, r);
  narShelter(b, seed, r);
  cookingCorner(b, seed, r);
  tyreSwing(b);
  skip(b, r);
  sacks(b);
  clutter(b);
  ropes(b);
  lantern(b);
  deadTree(b, seed);
  hut(b, seed);
  b.groundShade(0, 0.35, 0.3);
  slabs(b, seed);
  return b;
}
