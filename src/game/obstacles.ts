import type { Aabb } from '../world/layout';

const CELL = 16;
const key = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);

/** 16 m spatial hash of axis-aligned boxes. Logical entities (zombies, raiders, bullets, camera) query this instead of Rapier. */
export class ObstacleIndex {
  private cells = new Map<number, Aabb[]>();
  private all = new Map<number, Aabb>();
  /** Terrain height, so segment tests can take heights above the ground instead of absolute ones. */
  ground: ((x: number, z: number) => number) | null = null;

  add(a: Aabb) {
    if (this.all.has(a.id)) return;
    this.all.set(a.id, a);
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

  /** Visit boxes whose cell touches the circle. A box may be visited more than once across cells; callers must tolerate that. */
  near(x: number, z: number, r: number, fn: (a: Aabb) => void) {
    const seen = nearSeen;
    seen.clear();
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
    return this.segmentFirst(ax, az, bx, bz, y, ignoreKinds) !== null;
  }

  /** First box crossed by the segment, with the hit parameter t in [0,1]. */
  segmentFirst(ax: number, az: number, bx: number, bz: number, y = 1.2, ignoreKinds?: Set<string>): { a: Aabb; t: number } | null {
    const len = Math.hypot(bx - ax, bz - az);
    let best: { a: Aabb; t: number } | null = null;
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    this.near(mx, mz, len / 2 + 2, (a) => {
      if (ignoreKinds?.has(a.kind)) return;
      // Glass blocks a body but not a line of sight.
      if (a.mat === 'glass') return;
      // `y` is a height above the ground; boxes are placed in absolute heights.
      const yy = y + (a.gy ?? 0);
      if (yy < a.y0 || yy > a.y1) return;
      const t = segBox(ax, az, bx, bz, a);
      if (t !== null && (!best || t < best.t)) best = { a, t };
    });
    return best;
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
  }

  get count() {
    return this.all.size;
  }
}

const nearSeen = new Set<number>();

/** Slab test. Returns entry t in [0,1] or null. */
function segBox(ax: number, az: number, bx: number, bz: number, a: Aabb): number | null {
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  for (const [p, d, lo, hi] of [[ax, dx, a.minX, a.maxX], [az, dz, a.minZ, a.maxZ]] as const) {
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return null;
    } else {
      let ta = (lo - p) / d;
      let tb = (hi - p) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return null;
    }
  }
  return t0;
}
