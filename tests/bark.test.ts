import { describe, expect, it } from 'vitest';
import { BARK, BARK_ROUGH, BARK_SIZE, BARK_TILE, barkLayer } from '../src/render/barkTex';
import { treeGeometry } from '../src/render/trees';
import { TREE_SPECIES } from '../src/world/flora';

// Tree bark painted in code and laid on the trees at its true size: tileable layers, every piece of wood wearing one,
// nothing stretched, a eucalyptus's rough foot fading into its smooth stem.

const S = BARK_SIZE;
const layers = Object.values(BARK);

describe('bark layers', () => {
  it('tile without a seam either way', () => {
    for (const l of layers) {
      const d = barkLayer(l);
      const at = (x: number, y: number, c: number) => d[(y * S + x) * 4 + c];
      let inner = 0;
      let seamU = 0;
      let seamV = 0;
      for (let i = 0; i < S; i++) {
        for (let c = 0; c < 4; c++) {
          inner += Math.abs(at(S / 2, i, c) - at(S / 2 + 1, i, c)) + Math.abs(at(i, S / 2, c) - at(i, S / 2 + 1, c));
          seamU += Math.abs(at(S - 1, i, c) - at(0, i, c));
          seamV += Math.abs(at(i, S - 1, c) - at(i, 0, c));
        }
      }
      inner /= 2;
      // A seam is no rougher than any other column or row of the layer.
      expect(seamU, `layer ${l} round`).toBeLessThan(inner * 1.8 + S * 4);
      expect(seamV, `layer ${l} up`).toBeLessThan(inner * 1.8 + S * 4);
    }
  });

  it('keeps colour and relief in range, the smooth gum pale and its rough foot darker', () => {
    const mean = (l: number, c: number) => {
      const d = barkLayer(l);
      let s = 0;
      for (let i = 0; i < S * S; i++) s += d[i * 4 + c];
      return s / (S * S * 255);
    };
    for (const l of layers) {
      const m = mean(l, 1);
      expect(m, `layer ${l}`).toBeGreaterThan(0.3);
      expect(m, `layer ${l}`).toBeLessThan(0.95);
    }
    expect(mean(BARK.gum, 1)).toBeGreaterThan(0.75);
    expect(mean(BARK.gumRough, 1)).toBeLessThan(mean(BARK.gum, 1) - 0.1);
  });
});

describe('bark on the trees', () => {
  it('every piece of wood wears a bark layer, every leaf card none, never both in one triangle', () => {
    for (let sp = 0; sp < TREE_SPECIES.length; sp++) {
      const g = treeGeometry(sp);
      const B = g.getAttribute('bark');
      const idx = g.index!.array;
      let wood = 0;
      for (let t = 0; t < idx.length; t += 3) {
        const z = [B.getZ(idx[t]), B.getZ(idx[t + 1]), B.getZ(idx[t + 2])];
        expect(new Set(z).size, `${TREE_SPECIES[sp]} triangle ${t / 3}`).toBe(1);
        if (z[0] >= 0) {
          wood++;
          expect(layers).toContain(z[0]);
        } else expect(z[0]).toBe(-1);
      }
      expect(wood, TREE_SPECIES[sp]).toBeGreaterThan(30);
    }
  });

  it('lays the bark at its true size, square, on trunks, limbs and twigs alike', () => {
    for (let sp = 0; sp < TREE_SPECIES.length; sp++) {
      const g = treeGeometry(sp);
      const P = g.getAttribute('position');
      const B = g.getAttribute('bark');
      const idx = g.index!.array;
      let area = 0;
      let square = 0;
      let sized = 0;
      for (let t = 0; t < idx.length; t += 3) {
        const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
        const l = B.getZ(a);
        // The wood one sees from the ground: trunks, forks and the low limbs.
        if (l < 0 || Math.max(P.getY(a), P.getY(b), P.getY(c)) > 8) continue;
        const e1 = [P.getX(b) - P.getX(a), P.getY(b) - P.getY(a), P.getZ(b) - P.getZ(a)];
        const e2 = [P.getX(c) - P.getX(a), P.getY(c) - P.getY(a), P.getZ(c) - P.getZ(a)];
        const du1 = B.getX(b) - B.getX(a);
        const dv1 = B.getY(b) - B.getY(a);
        const du2 = B.getX(c) - B.getX(a);
        const dv2 = B.getY(c) - B.getY(a);
        const det = du1 * dv2 - du2 * dv1;
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const A = Math.hypot(cr[0], cr[1], cr[2]) / 2;
        if (Math.abs(det) < 1e-9 || A < 1e-6) continue;
        // Metres per tile along u and along v.
        const mu = Math.hypot(...[0, 1, 2].map((k) => (e1[k] * dv2 - e2[k] * dv1) / det));
        const mv = Math.hypot(...[0, 1, 2].map((k) => (e2[k] * du1 - e1[k] * du2) / det));
        area += A;
        if (Math.max(mu, mv) / Math.min(mu, mv) < 1.6) square += A;
        const tile = BARK_TILE[l];
        // The grain grows with the girth, as real bark's does, within about a quarter and twice the layer's tile.
        if (Math.sqrt(mu * mv) > tile * 0.2 && Math.sqrt(mu * mv) < tile * 2.5) sized += A;
      }
      expect(square / area, `${TREE_SPECIES[sp]} square`).toBeGreaterThan(TREE_SPECIES[sp] === 'eucalyptus' ? 0.95 : 0.88);
      expect(sized / area, `${TREE_SPECIES[sp]} true size`).toBeGreaterThan(0.9);
    }
  });

  it("fades an old gum's rough foot into its smooth stem, and only where a layer has a rough partner", () => {
    const g = treeGeometry(TREE_SPECIES.indexOf('eucalyptus'));
    const P = g.getAttribute('position');
    const B = g.getAttribute('bark');
    const T = g.getAttribute('tree');
    let foot = 0;
    let footRough = 0;
    let high = 0;
    for (let i = 0; i < P.count; i++) {
      const l = B.getZ(i);
      const w = B.getW(i);
      if (l < 0) continue;
      if (w > 0) expect(Math.floor(w)).toBe(BARK_ROUGH[l]?.layer ?? -99);
      if (T.getY(i) !== 0) continue;
      const amount = w - Math.floor(w);
      if (P.getY(i) < 0.8 && Math.hypot(P.getX(i), P.getZ(i)) < 1.2) {
        foot++;
        if (amount > 0.7) footRough++;
      }
      if (P.getY(i) > 7 && amount > 0.01) high++;
    }
    expect(foot).toBeGreaterThan(8);
    expect(footRough / foot).toBeGreaterThan(0.8);
    expect(high).toBe(0);
  });
});
