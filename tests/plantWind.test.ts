import { describe, expect, it } from 'vitest';
import { treeGeometry } from '../src/render/trees';
import { setPlantWind, WIND } from '../src/render/wind';
import { TREE_SPECIES } from '../src/world/flora';

/** The tree shader's unpacking of `tree.zw` (TREE_SWAY_GLSL), in JS. */
function unpack(t: ArrayLike<number>, i: number) {
  let q = t[i * 4 + 2];
  const sp = Math.floor(q / 262144);
  q -= sp * 262144;
  const pl = Math.floor(q / 4096);
  q -= pl * 4096;
  const p2 = Math.floor(q / 64);
  const f2 = Math.floor(t[i * 4 + 3] / 4096);
  return { loose: t[i * 4], variant: t[i * 4 + 1], sp, pl: pl / 64, p1: (q - p2 * 64) / 64, p2: p2 / 64, f1: (t[i * 4 + 3] - f2 * 4096) * 0.001, f2: f2 * 0.001 };
}

/** The shader's `treeLeafAxis`. */
function axisOf(w: number): [number, number, number] {
  const qv = Math.floor(w / 4096);
  const fx = ((w - qv * 4096) / 4095) * 2 - 1;
  const fy = (qv / 4095) * 2 - 1;
  const n = [fx, 1 - Math.abs(fx) - Math.abs(fy), fy];
  const t = Math.max(-n[1], 0);
  n[0] += n[0] >= 0 ? -t : t;
  n[2] += n[2] >= 0 ? -t : t;
  const l = Math.hypot(n[0], n[1], n[2]);
  return [n[0] / l, n[1] / l, n[2] / l];
}

const growPhase = (d: [number, number, number]) => {
  const x = Math.atan2(d[2], d[0]) / Math.PI + d[1] * 0.45;
  return x - Math.floor(x);
};

describe('plant wind', () => {
  it('packs every tree vertex exactly: species, variant, phases and give', () => {
    TREE_SPECIES.forEach((_, sp) => {
      const g = treeGeometry(sp);
      const t = g.getAttribute('tree');
      const l = g.getAttribute('aLeaf');
      expect(t.itemSize).toBe(4);
      expect(l.itemSize).toBe(4);
      const a = t.array as Float32Array;
      for (let i = 0; i < t.count; i++) {
        const u = unpack(a, i);
        expect(u.sp).toBe(sp);
        expect([0, 1, 2]).toContain(u.variant);
        expect(Number.isInteger(a[i * 4 + 2]) && Number.isInteger(a[i * 4 + 3])).toBe(true);
      }
    });
  });

  it('keeps the trunk and roots still and lets limbs give more toward their tips', () => {
    const sp = TREE_SPECIES.indexOf('oak');
    const g = treeGeometry(sp);
    const p = g.getAttribute('position');
    const a = g.getAttribute('tree').array as Float32Array;
    const wood: { r: number; y: number; give: number }[] = [];
    for (let i = 0; i < p.count; i++) {
      const u = unpack(a, i);
      if (u.loose > 0 || u.variant !== 0) continue;
      wood.push({ r: Math.hypot(p.getX(i), p.getZ(i)), y: p.getY(i), give: u.f1 + u.f2 });
    }
    for (const w of wood) if (w.y < 0.3) expect(w.give).toBe(0);
    const limbs = wood.filter((w) => w.give > 0).sort((x, y) => x.r - y.r);
    expect(limbs.length).toBeGreaterThan(100);
    const half = Math.floor(limbs.length / 2);
    const mean = (ws: typeof limbs) => ws.reduce((s, w) => s + w.give, 0) / ws.length;
    expect(mean(limbs.slice(half))).toBeGreaterThan(mean(limbs.slice(0, half)) * 1.5);
  });

  it('hangs each leaf from a point by its wood and times it by the angle it grows at', () => {
    for (const name of ['oak', 'willow', 'palm', 'eucalyptus'] as const) {
      const g = treeGeometry(TREE_SPECIES.indexOf(name));
      const p = g.getAttribute('position');
      const a = g.getAttribute('tree').array as Float32Array;
      const l = g.getAttribute('aLeaf').array as Float32Array;
      const leaves = new Map<string, number[]>();
      for (let i = 0; i < p.count; i++) {
        if (a[i * 4] <= 0) continue;
        const key = `${a[i * 4 + 1]}:${l[i * 4]}:${l[i * 4 + 1]}:${l[i * 4 + 2]}:${l[i * 4 + 3]}`;
        leaves.set(key, [...(leaves.get(key) ?? []), i]);
      }
      expect(leaves.size).toBeGreaterThan(20);
      const phases = new Set<number>();
      for (const verts of leaves.values()) {
        const i0 = verts[0];
        const hinge = [l[i0 * 4], l[i0 * 4 + 1], l[i0 * 4 + 2]];
        const ax = axisOf(l[i0 * 4 + 3]);
        expect(Math.hypot(...ax)).toBeCloseTo(1, 5);
        // The leaf reaches out from its hinge along its axis.
        let out = 0;
        for (const i of verts) out += (p.getX(i) - hinge[0]) * ax[0] + (p.getY(i) - hinge[1]) * ax[1] + (p.getZ(i) - hinge[2]) * ax[2];
        expect(out).toBeGreaterThan(0);
        // Its timing is its angle of growth (to the 64 steps it is packed in).
        const pl = unpack(a, i0).pl;
        const want = growPhase(ax);
        const d = Math.abs(pl - want);
        expect(Math.min(d, 1 - d)).toBeLessThan(1 / 64 + 0.01);
        phases.add(pl);
      }
      expect(phases.size).toBeGreaterThan(12);
    }
  });

  it('eases the plants toward the weather and carries the gusts downwind', () => {
    const w = WIND.uWind.value;
    w.set(1, 0, 0, 1);
    WIND.uWindRun.value = 0;
    for (let i = 0; i < 600; i++) setPlantWind(0, 15, 1 / 60);
    expect(w.z).toBeGreaterThan(14);
    expect(w.x).toBeLessThan(0.2);
    expect(WIND.uWindRun.value).toBeGreaterThan(80);
    for (let i = 0; i < 20000; i++) setPlantWind(0, 15, 1 / 60);
    expect(WIND.uWindRun.value).toBeLessThan(2000);
  });
});
