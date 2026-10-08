import * as THREE from 'three';

/**
 * Z-fighting finder for built geometry: pairs of triangles that lie in the same plane, face the same way and overlap. Two
 * such faces get the same depth at every pixel they share, so which one shows flips from frame to frame as the camera moves.
 * Back-to-back faces (opposite normals) are not counted: only one of them faces any eye.
 */
export interface CoplanarHit {
  a: string;
  b: string;
  /** Vertex colour of each face as hex, where the geometry has colours (tells which part of a model it is). */
  ca: string;
  cb: string;
  /** Overlap, square metres. */
  area: number;
  /** A point in the overlap, and the shared normal. */
  at: [number, number, number];
  n: [number, number, number];
}

interface Tri {
  src: string;
  col: string;
  p: THREE.Vector3[];
  n: THREE.Vector3;
  d: number;
}

function trisOf(g: THREE.BufferGeometry, src: string, out: Tri[]) {
  const pos = g.attributes.position;
  const idx = g.index;
  const n = idx ? idx.count : pos.count;
  const v = (i: number) => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
  const colA = g.attributes.color;
  const hex = (i: number) => (colA ? '#' + [colA.getX(i), colA.getY(i), colA.getZ(i)].map((c) => Math.round(Math.min(1, c) * 15).toString(16)).join('') : '');
  for (let i = 0; i + 2 < n; i += 3) {
    const p = [0, 1, 2].map((k) => v(idx ? idx.getX(i + k) : i + k));
    const nn = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
    const len = nn.length();
    if (len < 1e-8) continue;
    nn.divideScalar(len);
    out.push({ src, col: hex(idx ? idx.getX(i) : i), p, n: nn, d: nn.dot(p[0]) });
  }
}

/** Area of the overlap of two triangles in one plane (convex clip in the plane's own 2D frame). */
function overlap(a: Tri, b: Tri): { area: number; c: THREE.Vector3 } {
  const n = a.n;
  const u = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  u.addScaledVector(n, -u.dot(n)).normalize();
  const w = new THREE.Vector3().crossVectors(n, u);
  const to2 = (p: THREE.Vector3) => [p.dot(u), p.dot(w)] as [number, number];
  const A = a.p.map(to2);
  let poly = b.p.map(to2);
  // Counter-clockwise subject and clip.
  const area2 = (q: [number, number][]) => q.reduce((s, p, i) => s + p[0] * q[(i + 1) % q.length][1] - q[(i + 1) % q.length][0] * p[1], 0);
  if (area2(A) < 0) A.reverse();
  if (area2(poly) < 0) poly.reverse();
  for (let i = 0; i < 3 && poly.length; i++) {
    const [x1, y1] = A[i];
    const [x2, y2] = A[(i + 1) % 3];
    const side = (p: [number, number]) => (x2 - x1) * (p[1] - y1) - (y2 - y1) * (p[0] - x1);
    const next: [number, number][] = [];
    for (let j = 0; j < poly.length; j++) {
      const P = poly[j];
      const Q = poly[(j + 1) % poly.length];
      const sp = side(P);
      const sq = side(Q);
      if (sp >= 0) next.push(P);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        next.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
      }
    }
    poly = next;
  }
  if (poly.length < 3) return { area: 0, c: new THREE.Vector3() };
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  const c = new THREE.Vector3().addScaledVector(u, cx).addScaledVector(w, cy).addScaledVector(n, a.d);
  return { area: Math.abs(area2(poly)) / 2, c };
}

/**
 * Every same-facing coplanar overlap bigger than `minArea` between the named geometries (and within one: two faces of the
 * same mesh fight just the same). `tol` is how close two planes must be to count as one, metres.
 */
export function coplanarOverlaps(parts: { name: string; geo: THREE.BufferGeometry | null | undefined }[], minArea = 2e-4, tol = 4e-4, exposedOnly = false): CoplanarHit[] {
  const tris: Tri[] = [];
  for (const { name, geo } of parts) if (geo) trisOf(geo, name, tris);
  const exposed = exposedOnly ? exposure(tris) : null;
  // Bucket by plane: normal to 1e-3, offset to the tolerance (and look in the neighbouring offset bucket too).
  const buckets = new Map<string, Tri[]>();
  const nk = (t: Tri) => `${Math.round(t.n.x * 500)},${Math.round(t.n.y * 500)},${Math.round(t.n.z * 500)}`;
  for (const t of tris) {
    const k = `${nk(t)}|${Math.round(t.d / tol)}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(t);
  }
  const hits: CoplanarHit[] = [];
  for (const [k, list] of buckets) {
    const [nPart, dPart] = k.split('|');
    const next = buckets.get(`${nPart}|${Number(dPart) + 1}`) ?? [];
    const all = [...list, ...next];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = list[i];
        const b = all[j];
        if (Math.abs(a.d - b.d) > tol || a.n.dot(b.n) < 0.9995) continue;
        const o = overlap(a, b);
        if (o.area <= minArea) continue;
        if (exposed && !exposed(o.c, a.n)) continue;
        hits.push({ a: a.src, b: b.src, ca: a.col, cb: b.col, area: o.area, at: [o.c.x, o.c.y, o.c.z], n: [a.n.x, a.n.y, a.n.z] });
      }
    }
  }
  return hits;
}

/**
 * Whether a point on a surface can be seen from the side its normal faces: a short ray off it along the normal must not
 * start inside a solid (first hit a back face) nor run into another surface within a centimetre (a floor laid over a slab,
 * a box buried in a wall). Faces that fail are hidden, so a fight there never shows.
 */
function exposure(tris: Tri[]): (p: THREE.Vector3, n: THREE.Vector3) => boolean {
  const CELL = 0.5;
  const grid = new Map<string, Tri[]>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (const t of tris) {
    const lo = [0, 1, 2].map((k) => Math.floor(Math.min(...t.p.map((q) => q.getComponent(k))) / CELL));
    const hi = [0, 1, 2].map((k) => Math.floor(Math.max(...t.p.map((q) => q.getComponent(k))) / CELL));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const k = key(x, y, z);
      let c = grid.get(k);
      if (!c) grid.set(k, (c = []));
      c.push(t);
    }
  }
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const pv = new THREE.Vector3();
  const tv = new THREE.Vector3();
  const qv = new THREE.Vector3();
  const REACH = 0.3;
  /** The nearest surface a ray off `o` along `n` meets within reach, and whether it was met from behind. */
  const cast = (o: THREE.Vector3, n: THREE.Vector3): { d: number; back: boolean } => {
    const end = o.clone().addScaledVector(n, REACH);
    const seen = new Set<Tri>();
    let best = Infinity;
    let bestBack = false;
    const lo = [0, 1, 2].map((k) => Math.floor(Math.min(o.getComponent(k), end.getComponent(k)) / CELL));
    const hi = [0, 1, 2].map((k) => Math.floor(Math.max(o.getComponent(k), end.getComponent(k)) / CELL));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      for (const t of grid.get(key(x, y, z)) ?? []) {
        if (seen.has(t)) continue;
        seen.add(t);
        // Moller-Trumbore, both sides.
        e1.subVectors(t.p[1], t.p[0]);
        e2.subVectors(t.p[2], t.p[0]);
        pv.crossVectors(n, e2);
        const det = e1.dot(pv);
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        tv.subVectors(o, t.p[0]);
        const u = tv.dot(pv) * inv;
        if (u < 0 || u > 1) continue;
        qv.crossVectors(tv, e1);
        const v = n.dot(qv) * inv;
        if (v < 0 || u + v > 1) continue;
        const d = e2.dot(qv) * inv;
        if (d <= 0 || d > REACH || d >= best) continue;
        best = d;
        bestBack = t.n.dot(n) > 0;
      }
    }
    return { d: best, back: bestBack };
  };
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  return (p, n) => {
    const o = p.clone().addScaledVector(n, 1e-3);
    const straight = cast(o, n);
    if (straight.back || straight.d <= 0.01) return false;
    // Tilted rays too: a face at the foot of an open-bottomed wall sees nothing straight up, but meets the wall's
    // own faces from behind on every side.
    t1.set(Math.abs(n.x) < 0.9 ? 1 : 0, Math.abs(n.x) < 0.9 ? 0 : 1, 0).addScaledVector(n, -(Math.abs(n.x) < 0.9 ? n.x : n.y)).normalize();
    t2.crossVectors(n, t1);
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const dir = n.clone().addScaledVector(t1, a).addScaledVector(t2, b).normalize();
      if (cast(o, dir).back) return false;
    }
    return true;
  };
}
