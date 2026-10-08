import { clamp } from '../core/math';
import { heightAt, waterAt, type TerrainDef } from '../world/terrain';
import type { WaterStyle } from '../world/lakes';
import { shadeGround, type GroundShade, type MapRect, type MapTile, type TileSource } from './mapdata';

/**
 * The map's close-up ground: square tiles baked at a few metres a pixel around wherever a map is looking, drawn over the
 * coarser whole-leg image once the view is zoomed in far enough for its pixels to show. Each tile is baked a chunk of rows
 * at a time inside the frame budget the scene gives it, nearest the view first, and kept until it has gone unused for a
 * while (a small cache, oldest out). The shading is the whole-leg bake's own (`shadeGround`), so the two meet without a seam.
 */

/** Pixels per side of a tile's own square. Its image has one more all round, so neighbours blend into each other. */
const SIZE = 64;
const KEPT = 80;
/** Frames a tile stays wanted after the last ask (the minimap asks only every few frames). */
const STALE = 8;
const key = (ti: number, tj: number) => (ti + 4096) * 8192 + (tj + 4096);

interface Tile extends MapTile {
  ti: number;
  tj: number;
  key: number;
  /** Heights over the image plus one more pixel all round (for the slopes at its edge), filled a row at a time. */
  hs: Float32Array | null;
  depth: Float32Array | null;
  styles: (WaterStyle | null)[];
  data: Uint8ClampedArray;
  /** Next sample row, then next shade row. */
  srow: number;
  hrow: number;
  done: boolean;
  /** Last frame anyone wanted it. */
  used: number;
}

export class MapTiles implements TileSource {
  version = 0;
  readonly minScale: number;
  private tiles = new Map<number, Tile>();
  private frame = 0;
  /** Centres of the views asking this frame, so the nearest tiles are baked first. */
  private focus: { x: number; z: number }[] = [];
  private queue: Tile[] = [];
  private readonly span: number;

  constructor(
    private def: TerrainDef,
    /** The whole-leg bake's colouring, once its coarse pass has fixed the height range. */
    private shade: () => GroundShade | null,
    private bounds: MapRect,
    readonly cell = 4,
    baseCell = 12,
  ) {
    this.span = SIZE * cell;
    // Worth it once a base pixel would be three or more screen pixels across.
    this.minScale = 3 / baseCell;
  }

  want(r: MapRect) {
    const ti0 = Math.floor((Math.max(r.x0, this.bounds.x0) - this.bounds.x0) / this.span);
    const ti1 = Math.floor((Math.min(r.x1, this.bounds.x1) - this.bounds.x0) / this.span);
    const tj0 = Math.floor((Math.max(r.z0, this.bounds.z0) - this.bounds.z0) / this.span);
    const tj1 = Math.floor((Math.min(r.z1, this.bounds.z1) - this.bounds.z0) / this.span);
    // A view so wide it would want dozens of tiles is not zoomed in enough for them to matter.
    if ((ti1 - ti0 + 1) * (tj1 - tj0 + 1) > 36) return;
    this.focus.push({ x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 });
    for (let tj = tj0; tj <= tj1; tj++) {
      for (let ti = ti0; ti <= ti1; ti++) {
        const k = key(ti, tj);
        let t = this.tiles.get(k);
        if (!t) {
          t = this.make(ti, tj, k);
          this.tiles.set(k, t);
        }
        t.used = this.frame;
      }
    }
  }

  forEach(r: MapRect, cb: (t: MapTile) => void) {
    for (const t of this.tiles.values()) {
      if (!t.done || !t.canvas) continue;
      if (t.x0 + this.span < r.x0 || t.x0 > r.x1 || t.z0 + this.span < r.z0 || t.z0 > r.z1) continue;
      cb(t);
    }
  }

  /** Finished tiles, for tests. */
  get count() {
    let n = 0;
    for (const t of this.tiles.values()) if (t.done) n++;
    return n;
  }

  /** Is the tile covering this point finished? */
  doneAt(x: number, z: number): boolean {
    const t = this.tiles.get(key(Math.floor((x - this.bounds.x0) / this.span), Math.floor((z - this.bounds.z0) / this.span)));
    return !!t?.done;
  }

  /** The finished tile's pixel colour at a world point, for tests. */
  pixelAt(x: number, z: number): [number, number, number, number] | null {
    const t = this.tiles.get(key(Math.floor((x - this.bounds.x0) / this.span), Math.floor((z - this.bounds.z0) / this.span)));
    if (!t?.done) return null;
    const i = Math.floor((x - t.x0) / this.cell) + 1;
    const j = Math.floor((z - t.z0) / this.cell) + 1;
    const o = (j * (SIZE + 2) + i) * 4;
    return [t.data[o], t.data[o + 1], t.data[o + 2], t.data[o + 3]];
  }

  private make(ti: number, tj: number, k: number): Tile {
    const n = SIZE + 2;
    return {
      ti,
      tj,
      key: k,
      x0: this.bounds.x0 + ti * this.span,
      z0: this.bounds.z0 + tj * this.span,
      cell: this.cell,
      size: SIZE,
      canvas: null,
      hs: null,
      depth: null,
      styles: [],
      data: new Uint8ClampedArray(n * n * 4),
      srow: 0,
      hrow: 0,
      done: false,
      used: this.frame,
    };
  }

  /**
   * Bake for up to `ms`: the unfinished tiles asked for lately, nearest a view first. Call once a frame; the asks of the
   * frame are forgotten afterwards. Returns true if anything was finished.
   */
  step(ms: number): boolean {
    this.frame++;
    const shade = this.shade();
    let finished = false;
    if (shade) {
      const end = performance.now() + ms;
      if (!this.queue.length || this.frame % 15 === 0) this.order();
      while (this.queue.length && performance.now() < end) {
        const t = this.queue[0];
        if (t.done || this.frame - t.used > STALE) {
          this.queue.shift();
          continue;
        }
        if (this.work(t, shade, end)) {
          this.queue.shift();
          finished = true;
        }
      }
    }
    this.focus.length = 0;
    if (this.tiles.size > KEPT) this.evict();
    return finished;
  }

  private order() {
    const f = this.focus;
    const half = this.span / 2;
    const d = (t: Tile) => {
      let best = Infinity;
      for (const p of f) best = Math.min(best, Math.hypot(t.x0 + half - p.x, t.z0 + half - p.z));
      return best;
    };
    this.queue = [...this.tiles.values()].filter((t) => !t.done && this.frame - t.used <= STALE).sort((a, b) => d(a) - d(b));
  }

  /** Some rows of one tile. True once it is finished. */
  private work(t: Tile, s: GroundShade, end: number): boolean {
    const n = SIZE + 2;
    const m = SIZE + 4;
    const cell = this.cell;
    if (!t.hs) {
      t.hs = new Float32Array(m * m);
      t.depth = new Float32Array(m * m).fill(-1);
      t.styles = new Array(m * m).fill(null);
    }
    const hs = t.hs;
    // Samples: (SIZE + 4) square, starting two cells before the tile's own corner.
    while (t.srow < m) {
      const z = t.z0 + (t.srow - 2 + 0.5) * cell;
      for (let i = 0; i < m; i++) {
        const x = t.x0 + (i - 2 + 0.5) * cell;
        const k = t.srow * m + i;
        hs[k] = heightAt(this.def, x, z);
        const w = waterAt(this.def, x, z);
        if (w) {
          t.depth![k] = w.depth;
          t.styles[k] = w.style;
        }
      }
      t.srow++;
      if (performance.now() >= end) return false;
    }
    while (t.hrow < n) {
      const j = t.hrow;
      const sj = j + 1;
      const z = t.z0 + (j - 1 + 0.5) * cell;
      for (let i = 0; i < n; i++) {
        const si = i + 1;
        const k = sj * m + si;
        const x = t.x0 + (i - 1 + 0.5) * cell;
        shadeGround(t.data, (j * n + i) * 4, s, hs[k], hs[k - 1], hs[k + 1], hs[k - m], hs[k + m], cell, x, z, t.depth![k], t.styles[k]);
      }
      t.hrow++;
      if (performance.now() >= end && t.hrow < n) return false;
    }
    t.hs = null;
    t.depth = null;
    t.styles = [];
    t.done = true;
    this.upload(t);
    this.version++;
    return true;
  }

  private upload(t: Tile) {
    if (typeof document === 'undefined') return;
    const n = SIZE + 2;
    const c = document.createElement('canvas');
    c.width = n;
    c.height = n;
    const g = c.getContext('2d');
    if (!g) return;
    g.putImageData(new ImageData(t.data as Uint8ClampedArray<ArrayBuffer>, n, n), 0, 0);
    t.canvas = c;
  }

  private evict() {
    const all = [...this.tiles.values()].sort((a, b) => a.used - b.used);
    for (let k = 0; k < all.length - KEPT; k++) {
      const t = all[k];
      if (this.frame - t.used < STALE * 4) break;
      this.tiles.delete(t.key);
    }
    this.queue = this.queue.filter((t) => this.tiles.has(t.key));
  }

  dispose() {
    this.tiles.clear();
    this.queue.length = 0;
  }
}

void clamp;
