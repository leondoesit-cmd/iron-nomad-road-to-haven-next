import type { Aabb } from '../world/layout';

const CELL = 16;
const key = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);

/** 16 m spatial hash of axis-aligned boxes. Logical entities (zombies, raiders, bullets, camera) query this instead of Rapier. */
export class ObstacleIndex {
  private cells = new Map<number, Aabb[]>();
  private all = new Map<number, Aabb>();
  private order = new Map<number, number>();
  private nextOrder = 0;
  private segmentSeen = new Set<number>();
  private nearDepth = 0;
  private nearSets: Set<number>[] = [];
  /** Terrain height, so segment tests can take heights above the ground instead of absolute ones. */
  ground: ((x: number, z: number) => number) | null = null;

  add(a: Aabb) {
    if (this.all.has(a.id)) return;
    this.all.set(a.id, a);
    this.order.set(a.id, this.nextOrder++);
    a.gy = this.ground ? this.ground((a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2) : 0;
    for (let cx = Math.floor(a.minX / CELL); cx <= Math.floor(a.maxX / CELL); cx++) {
      for (let cz = Math.floor(a.minZ / CELL); cz <= Math.floor(a.maxZ / CELL); cz++) {
        const k = key(cx, cz);
        let arr = this.cells.get(k);
        if (!arr) this.cells.set(k, (arr = []));
        arr.push(a);
      }
    }
  }

  remove(a: Aabb) {
    if (!this.all.delete(a.id)) return;
    this.order.delete(a.id);
    for (let cx = Math.floor(a.minX / CELL); cx <= Math.floor(a.maxX / CELL); cx++) {
      for (let cz = Math.floor(a.minZ / CELL); cz <= Math.floor(a.maxZ / CELL); cz++) {
        const arr = this.cells.get(key(cx, cz));
        if (!arr) continue;
        const i = arr.indexOf(a);
        if (i >= 0) arr.splice(i, 1);
        if (!arr.length) this.cells.delete(key(cx, cz));
      }
    }
  }

  byId(id: number) {
    return this.all.get(id);
  }

  /** Visit each box once in cell order. Nested queries have independent scratch sets. */
  near(x: number, z: number, r: number, fn: (a: Aabb) => void) {
    const depth = this.nearDepth++;
    const seen = this.nearSets[depth] ?? (this.nearSets[depth] = new Set());
    seen.clear();
    try {
      for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
        for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
          const arr = this.cells.get(key(cx, cz));
          if (!arr) continue;
          for (const a of arr) {
            if (seen.has(a.id)) continue;
            seen.add(a.id);
            fn(a);
          }
        }
      }
    } finally { this.nearDepth--; }
  }

  /** Push a circle out of any box it overlaps. Returns the box it hit (if any) so zombies can attack barricades. */
  resolveCircle(p: { x: number; z: number }, r: number, ignoreKinds?: Set<string>, y?: number): Aabb | null {
    let hit: Aabb | null = null;
    this.near(p.x, p.z, r + 1, (a) => {
      if (ignoreKinds?.has(a.kind)) return;
      // Walls of an upper storey don't stop someone on the ground floor, and vice versa.
      if (y !== undefined && (a.y0 > y + 1.7 || a.y1 < y - 0.2)) return;
      const cx = Math.max(a.minX, Math.min(p.x, a.maxX));
      const cz = Math.max(a.minZ, Math.min(p.z, a.maxZ));
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) return;
      hit = a;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = r - d;
        p.x += (dx / d) * push;
        p.z += (dz / d) * push;
      } else {
        // Centre inside the box: shove out through the nearest face.
        const l = p.x - a.minX;
        const rr = a.maxX - p.x;
        const t = p.z - a.minZ;
        const b = a.maxZ - p.z;
        const m = Math.min(l, rr, t, b);
        if (m === l) p.x = a.minX - r;
        else if (m === rr) p.x = a.maxX + r;
        else if (m === t) p.z = a.minZ - r;
        else p.z = a.maxZ + r;
      }
    });
    return hit;
  }

  /** True if the open segment crosses any box tall enough to block (`y` in metres above the ground). */
  segmentBlocked(ax: number, az: number, bx: number, bz: number, y = 1.2, ignoreKinds?: Set<string>): boolean {
    return this.traceSegment(ax, az, bx, bz, y, ignoreKinds, true) !== null;
  }

  /** First box crossed by the segment, with the hit parameter t in [0,1]. */
  segmentFirst(ax: number, az: number, bx: number, bz: number, y = 1.2, ignoreKinds?: Set<string>): { a: Aabb; t: number } | null {
    return this.traceSegment(ax, az, bx, bz, y, ignoreKinds, false);
  }

  private traceSegment(ax: number, az: number, bx: number, bz: number, y: number, ignoreKinds: Set<string> | undefined, anyHit: boolean): { a: Aabb; t: number } | null {
    const dx = Math.abs(bx - ax) < 1e-9 ? 0 : bx - ax;
    const dz = Math.abs(bz - az) < 1e-9 ? 0 : bz - az;
    const len = Math.hypot(bx - ax, bz - az);
    let best: { a: Aabb; t: number } | null = null;
    const r = len / 2 + 2, mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const oldX0 = Math.floor((mx - r) / CELL), oldX1 = Math.floor((mx + r) / CELL);
    const oldZ0 = Math.floor((mz - r) / CELL), oldZ1 = Math.floor((mz + r) / CELL);
    // Walk a thin strip through each crossed row. Padding covers exact edges and corner round-off.
    const eps = 1e-7;
    const z0 = Math.max(oldZ0, Math.floor((Math.min(az, az + dz) - eps) / CELL));
    const z1 = Math.min(oldZ1, Math.floor((Math.max(az, az + dz) + eps) / CELL));
    const seen = this.segmentSeen;
    seen.clear();
    for (let cz = z0; cz <= z1; cz++) {
      let ta = 0, tb = 1;
      if (dz) {
        const a = (cz * CELL - az) / dz, b = ((cz + 1) * CELL - az) / dz;
        ta = Math.max(0, Math.min(a, b)); tb = Math.min(1, Math.max(a, b));
        if (ta > tb) continue;
      }
      const xa = ax + dx * ta, xb = ax + dx * tb;
      const x0 = Math.max(oldX0, Math.floor((Math.min(xa, xb) - eps) / CELL));
      const x1 = Math.min(oldX1, Math.floor((Math.max(xa, xb) + eps) / CELL));
      for (let cx = x0; cx <= x1; cx++) {
        const boxes = this.cells.get(key(cx, cz));
        if (!boxes) continue;
        for (const a of boxes) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          if (ignoreKinds?.has(a.kind) || a.mat === 'glass') continue;
          const yy = y + (a.gy ?? 0);
          if (yy < a.y0 || yy > a.y1) continue;
          const t = segBox(ax, az, bx, bz, a);
          if (t === null) continue;
          if (anyHit) return { a, t };
          if (!best || t < best.t || (t === best.t && this.earlierCell(a, best.a, oldX0, oldZ0))) best = { a, t };
        }
      }
    }
    return best;
  }

  /** Overlapping hits retain the original broad-square traversal's tie winner. */
  private earlierCell(a: Aabb, b: Aabb, x0: number, z0: number) {
    const ax = Math.max(x0, Math.floor(a.minX / CELL)), bx = Math.max(x0, Math.floor(b.minX / CELL));
    if (ax !== bx) return ax < bx;
    const az = Math.max(z0, Math.floor(a.minZ / CELL)), bz = Math.max(z0, Math.floor(b.minZ / CELL));
    return az !== bz ? az < bz : this.order.get(a.id)! < this.order.get(b.id)!;
  }

  /** Is the point inside any box? */
  pointInside(x: number, z: number, y = 1): Aabb | null {
    let hit: Aabb | null = null;
    this.near(x, z, 0.1, (a) => {
      if (x > a.minX && x < a.maxX && z > a.minZ && z < a.maxZ && y >= a.y0 && y <= a.y1) hit = a;
    });
    return hit;
  }

  clear() {
    this.cells.clear();
    this.all.clear();
    this.order.clear();
    this.nextOrder = 0;
    this.segmentSeen.clear();
  }

  get count() {
    return this.all.size;
  }
}

/** Slab test. Returns entry t in [0,1] or null. */
function segBox(ax: number, az: number, bx: number, bz: number, a: Aabb): number | null {
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  if (Math.abs(dx) < 1e-9) {
    if (ax < a.minX || ax > a.maxX) return null;
  } else {
    let ta = (a.minX - ax) / dx, tb = (a.maxX - ax) / dx;
    if (ta > tb) { const swap = ta; ta = tb; tb = swap; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  if (Math.abs(dz) < 1e-9) {
    if (az < a.minZ || az > a.maxZ) return null;
  } else {
    let ta = (a.minZ - az) / dz, tb = (a.maxZ - az) / dz;
    if (ta > tb) { const swap = ta; ta = tb; tb = swap; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}
