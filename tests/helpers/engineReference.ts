import type { ObstacleIndex } from '../../src/game/obstacles';
import type { Aabb } from '../../src/world/layout';
import { ENEMIES } from '../../src/data';
import { CELL, hearingRadius, type SigSource } from '../../src/sim/signature';
const senseRules = ENEMIES.zombieRules;
const radiusFor = hearingRadius;

// The pre-optimization algorithms, retained for differential regression tests and CPU benchmarks.
export function legacySegmentFirst(index: ObstacleIndex, ax: number, az: number, bx: number, bz: number, y = 1.2, ignore?: Set<string>): { a: Aabb; t: number } | null {
  const len = Math.hypot(bx - ax, bz - az);
  let best: { a: Aabb; t: number } | null = null;
  index.near((ax + bx) / 2, (az + bz) / 2, len / 2 + 2, a => {
    if (ignore?.has(a.kind) || a.mat === 'glass') return;
    const yy = y + (a.gy ?? 0);
    if (yy < a.y0 || yy > a.y1) return;
    const dx = bx - ax, dz = bz - az;
    let t0 = 0, t1 = 1;
    for (const [p, d, lo, hi] of [[ax, dx, a.minX, a.maxX], [az, dz, a.minZ, a.maxZ]] as const) {
      if (Math.abs(d) < 1e-9) { if (p < lo || p > hi) return; }
      else {
        let ta = (lo - p) / d, tb = (hi - p) / d;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) return;
      }
    }
    if (!best || t0 < best.t) best = { a, t: t0 };
  });
  return best;
}

export class LegacySignatureGrid {
  cells = new Map<number, SigSource>();
  private key(cx: number, cz: number) { return (cx + 32768) * 65536 + cz + 32768; }
  emit(x: number, z: number, level: number, channel: 'noise' | 'dust' = 'noise') {
    if (level <= 0) return;
    const k = this.key(Math.floor(x / CELL), Math.floor(z / CELL)), c = this.cells.get(k);
    if (!c || level >= c.level) this.cells.set(k, { level, x, z, channel });
  }
  loudestFor(x: number, z: number, indoors: boolean, channel: 'noise' | 'dust' = 'noise') {
    const r = Math.ceil(100 * senseRules.senseRadiusPerPoint / CELL);
    return this.query(x, z, r, channel, c => radiusFor(c.level, indoors));
  }
  strongestWithin(x: number, z: number, radius: number, channel: 'noise' | 'dust') {
    return this.query(x, z, Math.ceil(radius / CELL), channel, () => radius);
  }
  private query(x: number, z: number, r: number, channel: string, radius: (c: SigSource) => number) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let best: SigSource | null = null;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      const c = this.cells.get(this.key(cx + dx, cz + dz));
      if (!c || c.channel !== channel || Math.hypot(c.x - x, c.z - z) > radius(c)) continue;
      if (!best || c.level > best.level) best = c;
    }
    return best;
  }
  decay(dt: number) { for (const [k, c] of this.cells) { c.level -= 40 * dt; if (c.level <= 0) this.cells.delete(k); } }
  clear() { this.cells.clear(); }
}
