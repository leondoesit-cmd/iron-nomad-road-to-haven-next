import { CELL, heightAt, type TerrainDef } from '../world/terrain';
import { cliffDetail } from './chunkview';

/**
 * The ground as it is drawn, for laying water against it. The physics and `heightAt` know the exact ground; what the eye sees
 * is a mesh over it: the streamed chunks' 2 m grid (with the visual crags on the cliffs, split along the same diagonal as their
 * index buffer), and beyond them the far landscape's coarse grid. The depth test decides where water shows against those
 * meshes, not against `heightAt`, so the water's shorelines, its banks and its lift over the far mesh are measured here.
 */

/** How far the far landscape lies under the true ground, so its seams hide under the detailed chunks. */
export const FAR_SINK = 0.6;

/** The far landscape's grid: columns (offsets from the road in a corridor leg, x in the open world) and rows (z). */
export function farGridAxes(def: TerrainDef): { halfW: number; z0: number; z1: number; us: number[]; zs: number[] } {
  const open = def.open;
  const halfW = open ? open.x1 + 800 : 1500;
  const z0 = open ? def.zMin - 600 : -600;
  const z1 = open ? def.zMax + 700 : def.length + 900;
  // Dense near the canyon, coarse toward the mountains.
  const us: number[] = [];
  for (let u = -halfW; u <= halfW; ) {
    us.push(u);
    const a = Math.abs(u);
    u += open ? (a < open.x1 ? 24 : 60) : a < 240 ? 10 : a < 600 ? 20 : 40;
  }
  const zs: number[] = [];
  for (let z = z0; z <= z1; z += open ? 24 : 16) zs.push(z);
  return { halfW, z0, z1, us, zs };
}

/** Heights of the drawn ground meshes, sampled lazily and cached by grid point. One per build: it holds on to what it read. */
export class DrawnGround {
  private near = new Map<number, number>();
  private farH = new Map<number, number>();
  private axes: { us: number[]; zs: number[] } | null = null;

  constructor(private def: TerrainDef) {}

  private nearAt(c: number, r: number): number {
    const k = (c + 65536) * 131072 + (r + 65536);
    let h = this.near.get(k);
    if (h === undefined) {
      const x = c * CELL;
      const z = r * CELL;
      h = heightAt(this.def, x, z) + cliffDetail(this.def, x, z);
      this.near.set(k, h);
    }
    return h;
  }

  /** The streamed chunks' ground mesh at a point. */
  mesh(x: number, z: number): number {
    const fx = x / CELL;
    const fz = z / CELL;
    const c = Math.floor(fx);
    const r = Math.floor(fz);
    const tx = fx - c;
    const tz = fz - r;
    const a = this.nearAt(c, r);
    const b = this.nearAt(c + 1, r);
    const d = this.nearAt(c, r + 1);
    const e = this.nearAt(c + 1, r + 1);
    // Triangles (a, d, e) and (a, e, b), as `ChunkView.buildTerrain` and the physics heightfield split each cell.
    return tz > tx ? a + (e - d) * tx + (d - a) * tz : a + (b - a) * tx + (e - b) * tz;
  }

  /** The far landscape's mesh at a point (open world: its grid is laid over the map, not along the road). */
  far(x: number, z: number): number {
    const def = this.def;
    if (!def.open) return heightAt(def, x, z) - FAR_SINK;
    const ax = (this.axes ??= farGridAxes(def));
    const { us, zs } = ax;
    if (x <= us[0] || x >= us[us.length - 1] || z <= zs[0] || z >= zs[zs.length - 1]) return heightAt(def, x, z) - FAR_SINK;
    let lo = 0;
    let hi = us.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (us[mid] <= x) lo = mid;
      else hi = mid;
    }
    const dz = zs[1] - zs[0];
    const r = Math.min(zs.length - 2, Math.floor((z - zs[0]) / dz));
    const tx = (x - us[lo]) / (us[lo + 1] - us[lo]);
    const tz = (z - zs[r]) / dz;
    const a = this.farAt(lo, r);
    const b = this.farAt(lo + 1, r);
    const d = this.farAt(lo, r + 1);
    const e = this.farAt(lo + 1, r + 1);
    return tz > tx ? a + (e - d) * tx + (d - a) * tz : a + (b - a) * tx + (e - b) * tz;
  }

  private farAt(c: number, r: number): number {
    const k = c * 65536 + r;
    let h = this.farH.get(k);
    if (h === undefined) {
      const { us, zs } = this.axes!;
      h = heightAt(this.def, us[c], zs[r]) + cliffDetail(this.def, us[c], zs[r]) - FAR_SINK;
      this.farH.set(k, h);
    }
    return h;
  }
}
