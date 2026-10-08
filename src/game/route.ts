/**
 * A road graph for the map's route line and for a car that drives itself to you: the leg's road polylines joined where
 * they share a point, where one ends on another (a T) and where two cross (an X), searched with A*. Off-road legs at both
 * ends join the route to the roads, at a higher cost than the road itself, so a route takes the road whenever the road is
 * not a long way round. Pure: no scene, no DOM.
 */

export type RoadClass = 'highway' | 'road' | 'track';

export interface RoadLine {
  /** Centre-line as [x, z, x, z, ...]. */
  pts: number[];
  kind: RoadClass;
  half?: number;
}

/** How much a metre on each kind of ground costs: the route search prefers the cheaper. */
export const ROUTE_COST = { highway: 1, road: 1.08, track: 1.35, off: 2.4 } as const;
const CLASS_ID: Record<RoadClass, number> = { highway: 0, road: 1, track: 2 };
const CLASS_COST = [ROUTE_COST.highway, ROUTE_COST.road, ROUTE_COST.track];

/** Points of different roads closer than this become one junction. */
const SNAP = 4;
/** An end of a road this close to another road's line is joined to it (a T junction). */
const JOIN = 14;
const CELL = 64;
const key = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);

export interface RoadGraph {
  n: number;
  x: Float64Array;
  z: Float64Array;
  /** Adjacency in compressed rows: the edges of node i are `start[i]` up to `start[i + 1]`. */
  start: Int32Array;
  to: Int32Array;
  /** Edge length in metres, and the class of road it runs on. */
  len: Float32Array;
  cls: Uint8Array;
  /** Every undirected edge once, as node pairs, for the nearest-road search: a grid of segment indices by 64 m cell. */
  segA: Int32Array;
  segB: Int32Array;
  grid: Map<number, number[]>;
}

/** Builds the graph. Cheap: a few thousand points take a couple of milliseconds. */
export function buildRoadGraph(lines: RoadLine[]): RoadGraph {
  const xs: number[] = [];
  const zs: number[] = [];
  const nodeGrid = new Map<number, number[]>();
  const addNode = (x: number, z: number, snap: number): number => {
    const ix = Math.floor(x / CELL);
    const iz = Math.floor(z / CELL);
    if (snap > 0) {
      let best = -1;
      let bd = snap * snap;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = nodeGrid.get(key(ix + dx, iz + dz));
          if (!list) continue;
          for (const k of list) {
            const d = (xs[k] - x) ** 2 + (zs[k] - z) ** 2;
            if (d < bd) {
              bd = d;
              best = k;
            }
          }
        }
      }
      if (best >= 0) return best;
    }
    const k = xs.length;
    xs.push(x);
    zs.push(z);
    const c = key(ix, iz);
    const list = nodeGrid.get(c);
    if (list) list.push(k);
    else nodeGrid.set(c, [k]);
    return k;
  };

  // Each line's own points, and where other lines meet it along a segment (as a share of that segment, 0..1).
  const splits: { t: number; x: number; z: number }[][][] = lines.map((l) => Array.from({ length: Math.max(0, l.pts.length / 2 - 1) }, () => []));
  // A grid of every line segment, to find where lines touch.
  const segGrid = new Map<number, number[]>();
  const segRef: [number, number][] = [];
  lines.forEach((l, li) => {
    for (let s = 0; s + 3 < l.pts.length; s += 2) {
      const id = segRef.length;
      segRef.push([li, s / 2]);
      const x0 = Math.min(l.pts[s], l.pts[s + 2]) - JOIN;
      const x1 = Math.max(l.pts[s], l.pts[s + 2]) + JOIN;
      const z0 = Math.min(l.pts[s + 1], l.pts[s + 3]) - JOIN;
      const z1 = Math.max(l.pts[s + 1], l.pts[s + 3]) + JOIN;
      for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
        for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
          const c = key(ix, iz);
          const list = segGrid.get(c);
          if (list) list.push(id);
          else segGrid.set(c, [id]);
        }
      }
    }
  });
  const segsNear = (x: number, z: number, out: Set<number>) => {
    const list = segGrid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (list) for (const id of list) out.add(id);
  };
  const near = new Set<number>();
  // T junctions: a line's end lying on (or just short of) another line.
  lines.forEach((l, li) => {
    const n = l.pts.length / 2;
    if (n < 2) return;
    for (const e of [0, n - 1]) {
      const ex = l.pts[e * 2];
      const ez = l.pts[e * 2 + 1];
      near.clear();
      segsNear(ex, ez, near);
      let best: { li: number; s: number; t: number; d: number } | null = null;
      for (const id of near) {
        const [oi, s] = segRef[id];
        if (oi === li) continue;
        const p = lines[oi].pts;
        const t = projT(p[s * 2], p[s * 2 + 1], p[s * 2 + 2], p[s * 2 + 3], ex, ez);
        const px = p[s * 2] + (p[s * 2 + 2] - p[s * 2]) * t;
        const pz = p[s * 2 + 1] + (p[s * 2 + 3] - p[s * 2 + 1]) * t;
        const d = Math.hypot(px - ex, pz - ez);
        if (d < JOIN && (!best || d < best.d)) best = { li: oi, s, t, d };
      }
      if (best) {
        const p = lines[best.li].pts;
        const s = best.s;
        splits[best.li][s].push({ t: best.t, x: p[s * 2] + (p[s * 2 + 2] - p[s * 2]) * best.t, z: p[s * 2 + 1] + (p[s * 2 + 3] - p[s * 2 + 1]) * best.t });
      }
    }
  });
  // X junctions: two lines crossing between their points.
  lines.forEach((l, li) => {
    for (let s = 0; s + 3 < l.pts.length; s += 2) {
      const ax = l.pts[s];
      const az = l.pts[s + 1];
      const bx = l.pts[s + 2];
      const bz = l.pts[s + 3];
      near.clear();
      segsNear(ax, az, near);
      segsNear(bx, bz, near);
      for (const id of near) {
        const [oi, os] = segRef[id];
        if (oi <= li) continue;
        const p = lines[oi].pts;
        const hit = crossT(ax, az, bx, bz, p[os * 2], p[os * 2 + 1], p[os * 2 + 2], p[os * 2 + 3]);
        if (!hit) continue;
        const x = ax + (bx - ax) * hit[0];
        const z = az + (bz - az) * hit[0];
        splits[li][s / 2].push({ t: hit[0], x, z });
        splits[oi][os].push({ t: hit[1], x, z });
      }
    }
  });

  // Nodes and edges, each line walked with its inserted points in order.
  const ea: number[] = [];
  const eb: number[] = [];
  const el: number[] = [];
  const ec: number[] = [];
  const edgeSet = new Set<number>();
  const addEdge = (a: number, b: number, cls: number) => {
    if (a === b) return;
    const k = a < b ? a * 1048576 + b : b * 1048576 + a;
    if (edgeSet.has(k)) return;
    edgeSet.add(k);
    ea.push(a);
    eb.push(b);
    el.push(Math.hypot(xs[a] - xs[b], zs[a] - zs[b]));
    ec.push(cls);
  };
  lines.forEach((l, li) => {
    const n = l.pts.length / 2;
    if (n < 2) return;
    const cls = CLASS_ID[l.kind];
    let prev = addNode(l.pts[0], l.pts[1], SNAP);
    for (let s = 0; s < n - 1; s++) {
      const extra = splits[li][s].sort((a, b) => a.t - b.t);
      for (const q of extra) {
        const k = addNode(q.x, q.z, SNAP);
        addEdge(prev, k, cls);
        prev = k;
      }
      const k = addNode(l.pts[s * 2 + 2], l.pts[s * 2 + 3], SNAP);
      addEdge(prev, k, cls);
      prev = k;
    }
  });
  // A line whose end stopped just short of another: bridge the gap to the point it was joined at.
  lines.forEach((l) => {
    const n = l.pts.length / 2;
    if (n < 2) return;
    for (const e of [0, n - 1]) {
      const ex = l.pts[e * 2];
      const ez = l.pts[e * 2 + 1];
      const a = addNode(ex, ez, SNAP);
      let best = -1;
      let bd = JOIN * JOIN;
      const ix = Math.floor(ex / CELL);
      const iz = Math.floor(ez / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const k of nodeGrid.get(key(ix + dx, iz + dz)) ?? []) {
            if (k === a) continue;
            const d = (xs[k] - ex) ** 2 + (zs[k] - ez) ** 2;
            if (d < bd && d > SNAP * SNAP * 0.25) {
              bd = d;
              best = k;
            }
          }
        }
      }
      if (best >= 0 && !connected(a, best)) addEdge(a, best, CLASS_ID[l.kind]);
    }
  });
  function connected(a: number, b: number) {
    const k = a < b ? a * 1048576 + b : b * 1048576 + a;
    return edgeSet.has(k);
  }

  const n = xs.length;
  const deg = new Int32Array(n + 1);
  for (let i = 0; i < ea.length; i++) {
    deg[ea[i] + 1]++;
    deg[eb[i] + 1]++;
  }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const start = deg;
  const fill = start.slice(0, n);
  const to = new Int32Array(ea.length * 2);
  const len = new Float32Array(ea.length * 2);
  const cls = new Uint8Array(ea.length * 2);
  for (let i = 0; i < ea.length; i++) {
    let k = fill[ea[i]]++;
    to[k] = eb[i];
    len[k] = el[i];
    cls[k] = ec[i];
    k = fill[eb[i]]++;
    to[k] = ea[i];
    len[k] = el[i];
    cls[k] = ec[i];
  }
  const grid = new Map<number, number[]>();
  for (let i = 0; i < ea.length; i++) {
    const x0 = Math.min(xs[ea[i]], xs[eb[i]]);
    const x1 = Math.max(xs[ea[i]], xs[eb[i]]);
    const z0 = Math.min(zs[ea[i]], zs[eb[i]]);
    const z1 = Math.max(zs[ea[i]], zs[eb[i]]);
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
        const c = key(ix, iz);
        const list = grid.get(c);
        if (list) list.push(i);
        else grid.set(c, [i]);
      }
    }
  }
  return { n, x: Float64Array.from(xs), z: Float64Array.from(zs), start, to, len, cls, segA: Int32Array.from(ea), segB: Int32Array.from(eb), grid };
}

/** Where along a-b the point nearest p lies, 0..1. */
function projT(ax: number, az: number, bx: number, bz: number, px: number, pz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  if (l2 < 1e-9) return 0;
  return Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l2));
}

/** Where segments a-b and c-d cross (as a share of each), strictly inside both, or null. */
function crossT(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): [number, number] | null {
  const rx = bx - ax;
  const rz = bz - az;
  const sx = dx - cx;
  const sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den;
  const u = ((cx - ax) * rz - (cz - az) * rx) / den;
  if (t <= 0.02 || t >= 0.98 || u <= 0.02 || u >= 0.98) return null;
  return [t, u];
}

/** The nearest point on any road within `reach` metres: which edge, how far along it, and the point. */
export interface RoadHit {
  seg: number;
  t: number;
  x: number;
  z: number;
  d: number;
}

/** Up to `k` nearest road points within `reach`, at most one per edge, nearest first. */
export function nearestRoads(g: RoadGraph, x: number, z: number, reach: number, k = 4): RoadHit[] {
  const out: RoadHit[] = [];
  const seen = new Set<number>();
  const r = Math.ceil(reach / CELL);
  const ix = Math.floor(x / CELL);
  const iz = Math.floor(z / CELL);
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      const list = g.grid.get(key(ix + dx, iz + dz));
      if (!list) continue;
      for (const s of list) {
        if (seen.has(s)) continue;
        seen.add(s);
        const a = g.segA[s];
        const b = g.segB[s];
        const t = projT(g.x[a], g.z[a], g.x[b], g.z[b], x, z);
        const px = g.x[a] + (g.x[b] - g.x[a]) * t;
        const pz = g.z[a] + (g.z[b] - g.z[a]) * t;
        const d = Math.hypot(px - x, pz - z);
        if (d <= reach) out.push({ seg: s, t, x: px, z: pz, d });
      }
    }
  }
  out.sort((p, q) => p.d - q.d);
  // Keep the nearest few that are not all on one bend of the same road.
  const pick: RoadHit[] = [];
  for (const h of out) {
    if (pick.length >= k) break;
    if (pick.some((p) => Math.hypot(p.x - h.x, p.z - h.z) < 12)) continue;
    pick.push(h);
  }
  return pick;
}

export interface Route {
  /** The way as [x, z, x, z, ...], from the start to the goal. */
  pts: number[];
  /** Metres along it. */
  length: number;
  /** How many of the first and last segments are off the road (0 or 1 each); a route that never meets a road is all off. */
  offStart: number;
  offEnd: number;
  /** True when no road was worth taking: the whole thing is a straight line. */
  direct: boolean;
}

class Heap {
  ids: number[] = [];
  keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, k: number) {
    const ids = this.ids;
    const ks = this.keys;
    let i = ids.length;
    ids.push(id);
    ks.push(k);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (ks[p] <= k) break;
      ids[i] = ids[p];
      ks[i] = ks[p];
      i = p;
    }
    ids[i] = id;
    ks[i] = k;
  }
  pop(): number {
    const ids = this.ids;
    const ks = this.keys;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastK = ks.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && ks[r] < ks[l] ? r : l;
        if (ks[c] >= lastK) break;
        ids[i] = ids[c];
        ks[i] = ks[c];
        i = c;
      }
      ids[i] = lastId;
      ks[i] = lastK;
    }
    return top;
  }
}

/**
 * The cheapest way from a to b: off the road to one of the nearest roads, along the network, and off it again to the goal,
 * or straight across when that is cheaper. `reach` is how far from a road the ends may be and still join it.
 */
export function findRoute(g: RoadGraph | null, ax: number, az: number, bx: number, bz: number, reach = 320): Route {
  const straight = Math.hypot(bx - ax, bz - az);
  const direct: Route = { pts: [ax, az, bx, bz], length: straight, offStart: 1, offEnd: 0, direct: true };
  if (!g || g.n === 0 || straight < 30) return direct;
  const from = nearestRoads(g, ax, az, reach, 4);
  const into = nearestRoads(g, bx, bz, reach, 4);
  if (!from.length || !into.length) return direct;
  // Node ids: the graph's own, then the start (n), the goal (n + 1), then the entry and exit points on the roads.
  const n = g.n;
  const S = n;
  const T = n + 1;
  const entry = (i: number) => n + 2 + i;
  const exit = (i: number) => n + 2 + from.length + i;
  const total = n + 2 + from.length + into.length;
  const cost = new Float64Array(total).fill(Infinity);
  const prev = new Int32Array(total).fill(-1);
  const done = new Uint8Array(total);
  const px = (id: number) => (id < n ? g.x[id] : id === S ? ax : id === T ? bx : id < n + 2 + from.length ? from[id - n - 2].x : into[id - n - 2 - from.length].x);
  const pz = (id: number) => (id < n ? g.z[id] : id === S ? az : id === T ? bz : id < n + 2 + from.length ? from[id - n - 2].z : into[id - n - 2 - from.length].z);
  // Edges an exit point adds to the two ends of the road it sits on, so the search can reach it from the network.
  const exitsOn = new Map<number, number[]>();
  into.forEach((h, i) => {
    for (const nd of [g.segA[h.seg], g.segB[h.seg]]) {
      const list = exitsOn.get(nd);
      if (list) list.push(i);
      else exitsOn.set(nd, [i]);
    }
  });
  const segCost = (seg: number) => {
    // The class of an edge, read from either direction of it in the adjacency.
    const a = g.segA[seg];
    for (let k = g.start[a]; k < g.start[a + 1]; k++) if (g.to[k] === g.segB[seg]) return CLASS_COST[g.cls[k]];
    return ROUTE_COST.road;
  };
  const heap = new Heap();
  const relax = (from_: number, to_: number, c: number) => {
    if (done[to_]) return;
    const nc = cost[from_] + c;
    if (nc < cost[to_]) {
      cost[to_] = nc;
      prev[to_] = from_;
      heap.push(to_, nc + Math.hypot(px(to_) - bx, pz(to_) - bz) * ROUTE_COST.highway);
    }
  };
  cost[S] = 0;
  heap.push(S, straight);
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === T) break;
    if (u === S) {
      relax(S, T, straight * ROUTE_COST.off);
      from.forEach((h, i) => relax(S, entry(i), h.d * ROUTE_COST.off));
      continue;
    }
    if (u >= n + 2) {
      const ui = u - n - 2;
      if (ui < from.length) {
        // An entry point: onto the road it lies on, either way.
        const h = from[ui];
        const c = segCost(h.seg);
        const L = Math.hypot(g.x[g.segB[h.seg]] - g.x[g.segA[h.seg]], g.z[g.segB[h.seg]] - g.z[g.segA[h.seg]]);
        relax(u, g.segA[h.seg], L * h.t * c);
        relax(u, g.segB[h.seg], L * (1 - h.t) * c);
        // Both ends on the same stretch of road: straight along it.
        into.forEach((e, j) => {
          if (e.seg === h.seg) relax(u, exit(j), L * Math.abs(e.t - h.t) * c);
        });
      } else {
        const h = into[ui - from.length];
        relax(u, T, h.d * ROUTE_COST.off);
      }
      continue;
    }
    for (let k = g.start[u]; k < g.start[u + 1]; k++) relax(u, g.to[k], g.len[k] * CLASS_COST[g.cls[k]]);
    const ex = exitsOn.get(u);
    if (ex) {
      for (const j of ex) {
        const h = into[j];
        const L = Math.hypot(g.x[g.segB[h.seg]] - g.x[g.segA[h.seg]], g.z[g.segB[h.seg]] - g.z[g.segA[h.seg]]);
        const t = u === g.segA[h.seg] ? h.t : 1 - h.t;
        relax(u, exit(j), L * t * segCost(h.seg));
      }
    }
  }
  if (!Number.isFinite(cost[T]) || prev[T] === S) return direct;
  const ids: number[] = [];
  for (let id = T; id >= 0; id = prev[id]) ids.push(id);
  ids.reverse();
  const pts: number[] = [];
  let length = 0;
  for (const id of ids) {
    const x = px(id);
    const z = pz(id);
    const m = pts.length;
    if (m >= 2) {
      const d = Math.hypot(x - pts[m - 2], z - pts[m - 1]);
      if (d < 0.5) continue;
      length += d;
    }
    pts.push(x, z);
  }
  return { pts, length, offStart: 1, offEnd: 1, direct: false };
}

/** The point `ahead` metres further along a route from its closest point to (x, z), searching from segment `from` on. */
export function alongRoute(pts: number[], x: number, z: number, ahead: number, from = 0): { x: number; z: number; seg: number; left: number } {
  const n = pts.length / 2;
  if (n < 2) return { x: pts[0] ?? x, z: pts[1] ?? z, seg: 0, left: 0 };
  let best = Math.min(from, n - 2);
  let bd = Infinity;
  let bt = 0;
  // Only a little way back and a stretch forward: the route is followed, not jumped about on.
  for (let s = Math.max(0, from - 2); s < Math.min(n - 1, from + 40); s++) {
    const t = projT(pts[s * 2], pts[s * 2 + 1], pts[s * 2 + 2], pts[s * 2 + 3], x, z);
    const qx = pts[s * 2] + (pts[s * 2 + 2] - pts[s * 2]) * t;
    const qz = pts[s * 2 + 1] + (pts[s * 2 + 3] - pts[s * 2 + 1]) * t;
    const d = (qx - x) ** 2 + (qz - z) ** 2;
    if (d < bd) {
      bd = d;
      best = s;
      bt = t;
    }
  }
  let s = best;
  let t = bt;
  let want = ahead;
  let left = 0;
  // What is left of the route from the closest point.
  {
    const L = Math.hypot(pts[s * 2 + 2] - pts[s * 2], pts[s * 2 + 3] - pts[s * 2 + 1]);
    left = L * (1 - t);
    for (let k = s + 1; k < n - 1; k++) left += Math.hypot(pts[k * 2 + 2] - pts[k * 2], pts[k * 2 + 3] - pts[k * 2 + 1]);
  }
  for (;;) {
    const L = Math.hypot(pts[s * 2 + 2] - pts[s * 2], pts[s * 2 + 3] - pts[s * 2 + 1]);
    const rest = L * (1 - t);
    if (want <= rest || s >= n - 2) {
      const tt = L > 1e-6 ? Math.min(1, t + want / L) : 1;
      return { x: pts[s * 2] + (pts[s * 2 + 2] - pts[s * 2]) * tt, z: pts[s * 2 + 1] + (pts[s * 2 + 3] - pts[s * 2 + 1]) * tt, seg: best, left };
    }
    want -= rest;
    s++;
    t = 0;
  }
}

/** How far a point is from a route's line, in metres. */
export function offRoute(pts: number[], x: number, z: number): number {
  let bd = Infinity;
  for (let s = 0; s + 3 < pts.length; s += 2) {
    const t = projT(pts[s], pts[s + 1], pts[s + 2], pts[s + 3], x, z);
    const d = (pts[s] + (pts[s + 2] - pts[s]) * t - x) ** 2 + (pts[s + 1] + (pts[s + 3] - pts[s + 1]) * t - z) ** 2;
    if (d < bd) bd = d;
  }
  return Math.sqrt(bd);
}
