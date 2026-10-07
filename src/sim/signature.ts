import { ENEMIES } from '../data';
const senseRules = ENEMIES.zombieRules;

export const CELL = 16;
export const DECAY_PER_SEC = 40;

export interface SigSource {
  level: number;
  x: number;
  z: number;
  /** Which channel: Noise is heard in cities, Dust is seen in wastelands. */
  channel: 'noise' | 'dust';
}

/** Sense radius is 0.8 m per Noise point, halved indoors. */
export function hearingRadius(level: number, indoors: boolean) {
  return level * senseRules.senseRadiusPerPoint * (indoors ? senseRules.indoorFactor : 1);
}

/** Dust plume: visible at 3 m per point, halved in storms. */
export function dustRadius(level: number, storm: boolean) {
  return level * 3 * (storm ? 0.5 : 1);
}
const radiusFor = hearingRadius;

/** 16 m spatial hash. Emitters write at 3 Hz; listeners do grid lookups instead of N-by-M distance checks. */
export class SignatureGrid {
  private cells = new Map<number, SigSource>();

  private key(cx: number, cz: number) {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  emit(x: number, z: number, level: number, channel: 'noise' | 'dust' = 'noise') {
    if (level <= 0) return;
    const k = this.key(Math.floor(x / CELL), Math.floor(z / CELL));
    const c = this.cells.get(k);
    if (!c || level >= c.level) this.cells.set(k, { level, x, z, channel });
  }

  /** Loudest source this listener can hear. */
  loudestFor(x: number, z: number, indoors: boolean, channel: 'noise' | 'dust' = 'noise'): SigSource | null {
    const r = Math.ceil((100 * senseRules.senseRadiusPerPoint) / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    if (this.cells.size < (2 * r + 1) ** 2) return this.sparseStrongest(x, z, cx, cz, r, channel, indoors);
    let best: SigSource | null = null;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const c = this.cells.get(this.key(cx + dx, cz + dz));
        if (!c || c.channel !== channel) continue;
        const d = Math.hypot(c.x - x, c.z - z);
        if (d > radiusFor(c.level, indoors)) continue;
        if (!best || c.level > best.level) best = c;
      }
    }
    return best;
  }

  /** Strongest source within a radius regardless of channel rules (used by raiders reading Dust). */
  strongestWithin(x: number, z: number, radius: number, channel: 'noise' | 'dust'): SigSource | null {
    const r = Math.ceil(radius / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    if (this.cells.size < (2 * r + 1) ** 2) return this.sparseStrongest(x, z, cx, cz, r, channel, false, radius);
    let best: SigSource | null = null;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const c = this.cells.get(this.key(cx + dx, cz + dz));
        if (!c || c.channel !== channel) continue;
        if (Math.hypot(c.x - x, c.z - z) > radius) continue;
        if (!best || c.level > best.level) best = c;
      }
    }
    return best;
  }

  /** Sparse scenes visit emitters instead of probing empty cells. Equal levels retain cell scan order. */
  private sparseStrongest(x: number, z: number, cx: number, cz: number, r: number, channel: 'noise' | 'dust', indoors: boolean, radius?: number) {
    let best: SigSource | null = null, bestKey = Infinity;
    const base = this.key(cx - r, cz - r);
    if (!Number.isFinite(base)) return null;
    for (const [key, source] of this.cells) {
      if (source.channel !== channel || (best && source.level < best.level)) continue;
      const offset = key - base, row = Math.floor(offset / 65536), col = offset - row * 65536;
      if (row < 0 || row > 2 * r || col < 0 || col > 2 * r) continue;
      if (Math.hypot(source.x - x, source.z - z) > (radius ?? radiusFor(source.level, indoors))) continue;
      if (!best || source.level > best.level || (source.level === best.level && key < bestKey)) { best = source; bestKey = key; }
    }
    return best;
  }

  decay(dt: number) {
    for (const [k, c] of this.cells) {
      c.level -= DECAY_PER_SEC * dt;
      if (c.level <= 0) this.cells.delete(k);
    }
  }

  get size() {
    return this.cells.size;
  }

  clear() {
    this.cells.clear();
  }
}
