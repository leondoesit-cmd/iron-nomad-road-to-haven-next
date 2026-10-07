import { describe, expect, it } from 'vitest';
import { narYardModel } from '../src/render/narYardModel';
import { YARD_CLEAR, YARD_HALF, YARD_ITEMS, YARD_NAR, YARD_SOLIDS, shelterYard } from '../src/world/narYard';

// Nar's yard: the static model of the ruined workshop where the story opens, and its colliders.

const yard = narYardModel(1);
const pos = yard.pos;
const idx = yard.idx;
const tris = idx.length / 3;

/**
 * Below this a person (or the trike, or a part being carried) is in the way. The roof, the ridge and the ropes run overhead
 * across the work floor above it, as the frames do in the old game; nothing stands in a keep-clear circle under it.
 */
const HEADROOM = 2.5;

type P = [number, number, number];
const vert = (i: number): P => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];

/** Calls `fn` for points spread over every triangle (vertices, edges and inside), about every 4 cm. */
function eachSurfacePoint(fn: (x: number, y: number, z: number) => void, keep: (lo: P, hi: P) => boolean) {
  for (let t = 0; t < tris; t++) {
    const a = vert(idx[t * 3]);
    const b = vert(idx[t * 3 + 1]);
    const c = vert(idx[t * 3 + 2]);
    const lo: P = [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])];
    const hi: P = [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])];
    if (!keep(lo, hi)) continue;
    const edge = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]));
    const n = Math.max(1, Math.ceil(edge / 0.04));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n;
        const v = j / n;
        const w = 1 - u - v;
        fn(a[0] * w + b[0] * u + c[0] * v, a[1] * w + b[1] * u + c[1] * v, a[2] * w + b[2] * u + c[2] * v);
      }
    }
  }
}

/** Highest surface straight below (x, from, z): a ray cast down through every triangle. */
function groundBelow(x: number, z: number, from: number): number {
  let best = -Infinity;
  for (let t = 0; t < tris; t++) {
    const a = vert(idx[t * 3]);
    const b = vert(idx[t * 3 + 1]);
    const c = vert(idx[t * 3 + 2]);
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
    const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const y = l1 * a[1] + l2 * b[1] + l3 * c[1];
    if (y <= from && y > best) best = y;
  }
  return best;
}

describe("Nar's yard model", () => {
  it('builds one merged mesh with every attribute in step', () => {
    expect(tris).toBeGreaterThan(5000);
    const n = pos.length / 3;
    expect(yard.nor.length).toBe(n * 3);
    expect(yard.col.length).toBe(n * 3);
    expect(yard.srf.length).toBe(n * 4);
    expect(yard.uv.length).toBe(n * 2);
    for (const i of idx) expect(i >= 0 && i < n).toBe(true);
    for (const v of pos) expect(Number.isFinite(v)).toBe(true);
    const g = yard.build();
    expect(g.getAttribute('position').count).toBe(n);
  });

  it('fits the yard: within YARD_HALF of its centre, under 6 m tall, under the triangle budget', () => {
    let lo: P = [Infinity, Infinity, Infinity];
    let hi: P = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      lo = [Math.min(lo[0], pos[i]), Math.min(lo[1], pos[i + 1]), Math.min(lo[2], pos[i + 2])];
      hi = [Math.max(hi[0], pos[i]), Math.max(hi[1], pos[i + 1]), Math.max(hi[2], pos[i + 2])];
    }
    for (const k of [0, 2]) {
      expect(lo[k]).toBeGreaterThan(-YARD_HALF);
      expect(hi[k]).toBeLessThan(YARD_HALF);
    }
    expect(hi[1]).toBeLessThan(6);
    // The frames reach about 4.5 m: it reads as a building, not a fence.
    expect(hi[1]).toBeGreaterThan(4.3);
    expect(lo[1]).toBeGreaterThan(-0.2);
    expect(tris).toBeLessThan(60000);
  });

  it('keeps every gameplay spot clear below head height (Nar lies on his own pallet)', () => {
    const circles = YARD_CLEAR.slice(1);
    const hits: string[] = [];
    eachSurfacePoint(
      (x, y, z) => {
        if (y <= 0.05 || y >= HEADROOM) return;
        for (const c of circles) {
          if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r * c.r) {
            if (hits.length < 8) hits.push(`(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) in circle at (${c.x}, ${c.z})`);
          }
        }
      },
      (lo, hi) => hi[1] > 0.05 && lo[1] < HEADROOM && circles.some((c) => hi[0] > c.x - c.r && lo[0] < c.x + c.r && hi[2] > c.z - c.r && lo[2] < c.z + c.r),
    );
    expect(hits).toEqual([]);
  });

  it('keeps the drive-out lane open to the front', () => {
    // Nothing at all stands between the trike and the open front below head height, the length of the lane.
    let blocked = 0;
    eachSurfacePoint(
      (x, y, z) => {
        if (y > 0.05 && y < HEADROOM && Math.abs(x - 0.6) < 1.3 && z > 0.4 && z < 9) blocked++;
      },
      (lo, hi) => hi[1] > 0.05 && lo[1] < HEADROOM && hi[0] > -0.7 && lo[0] < 1.9 && hi[2] > 0.4,
    );
    expect(blocked).toBe(0);
  });

  it('puts the pallet top where Nar lies, and the bench top under the dog food', () => {
    // Along his body in the lean-to's own frame (on a board, not in a gap between two), from the feet toward the head.
    for (const d of [-0.8, -0.3, 0, 0.3]) {
      const at = shelterYard(0.06, 0.03 - d);
      const y = groundBelow(at.x, at.z, 0.5);
      expect(y).toBeGreaterThan(YARD_NAR.y - 0.006);
      expect(y).toBeLessThan(YARD_NAR.y + 0.006);
    }
    const food = YARD_ITEMS.find((i) => i.id === 'dogfood')!;
    const top = groundBelow(food.x, food.z, 1.3);
    expect(Math.abs(top - food.y!)).toBeLessThan(0.003);
  });
});

describe("Nar's yard colliders", () => {
  it('stand clear of every keep-clear circle', () => {
    for (const s of YARD_SOLIDS) {
      for (const c of YARD_CLEAR) {
        const nx = Math.max(s.x - s.hx, Math.min(c.x, s.x + s.hx));
        const nz = Math.max(s.z - s.hz, Math.min(c.z, s.z + s.hz));
        expect(Math.hypot(nx - c.x, nz - c.z), `solid at (${s.x}, ${s.z}) vs circle at (${c.x}, ${c.z})`).toBeGreaterThan(c.r);
      }
    }
  });

  it('each stand on something the model draws, inside the yard', () => {
    const found = YARD_SOLIDS.map(() => 0);
    eachSurfacePoint(
      (x, y, z) => {
        YARD_SOLIDS.forEach((s, k) => {
          if (y > 0.05 && y < s.h + 0.05 && Math.abs(x - s.x) <= s.hx + 0.02 && Math.abs(z - s.z) <= s.hz + 0.02) found[k]++;
        });
      },
      (lo, hi) => hi[1] > 0.05 && lo[1] < 3.1,
    );
    YARD_SOLIDS.forEach((s, k) => {
      expect(found[k], `solid at (${s.x}, ${s.z})`).toBeGreaterThan(10);
      expect(Math.abs(s.x) + s.hx).toBeLessThan(YARD_HALF);
      expect(Math.abs(s.z) + s.hz).toBeLessThan(YARD_HALF);
      expect(s.h).toBeGreaterThan(0);
    });
  });
});
