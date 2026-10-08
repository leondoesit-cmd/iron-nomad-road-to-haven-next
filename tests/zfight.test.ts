import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { legById } from '../src/data';
import { COPLANAR, PULL, coplanarOffset, depthResolution, depthToViewZ, pullStep, roadPull, viewDistToDepth } from '../src/render/depth';
import { buildBuildingGeometry, SLAB_INSET } from '../src/render/buildingView';
import { ChunkSource } from '../src/world/chunkgen';
import { generatePlan, type Look } from '../src/world/interiors';
import { roadLayer } from '../src/world/openWorld';
import { makeTerrainDef } from '../src/world/terrain';
import { coplanarOverlaps } from './helpers/coplanar';

const NEAR = 0.2;
const FAR = 3400;

describe('depth precision', () => {
  it('turns a depth value back into the distance it was written at, either way round', () => {
    for (const reversed of [false, true]) {
      for (const dist of [0.2, 0.35, 1, 7.5, 60, 333, 1000, 2999]) {
        const d = viewDistToDepth(dist, NEAR, FAR, reversed);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(1);
        expect(-depthToViewZ(d, NEAR, FAR, reversed)).toBeCloseTo(dist, 6);
      }
      // Near and far land on the ends of the range: 0 near and 1 far, or the other way round.
      expect(viewDistToDepth(NEAR, NEAR, FAR, reversed)).toBeCloseTo(reversed ? 1 : 0, 9);
      expect(viewDistToDepth(FAR, NEAR, FAR, reversed)).toBeCloseTo(reversed ? 0 : 1, 9);
    }
  });

  it('reversed float depth separates surfaces far finer than the 24-bit buffer it replaced', () => {
    const classic = (d: number) => depthResolution(d, NEAR, FAR, { reversed: false, float: false, bits: 24 });
    const reversed = (d: number) => depthResolution(d, NEAR, FAR, { reversed: true, float: true });
    // The old buffer: a few centimetres at 300 m and a third of a metre at a kilometre, where roads, sills and slabs a few
    // centimetres apart flickered.
    expect(classic(300)).toBeGreaterThan(0.02);
    expect(classic(1000)).toBeGreaterThan(0.25);
    // Reversed float: well under a millimetre at a kilometre, and about the same fraction of the distance everywhere.
    expect(reversed(300)).toBeLessThan(1e-4);
    expect(reversed(1000)).toBeLessThan(5e-4);
    expect(reversed(1000) / 1000).toBeLessThan(4 * (reversed(10) / 10));
    // The geometric gaps the world relies on are resolved everywhere the view reaches.
    for (const gap of [0.004, 0.012, 0.035]) expect(reversed(FAR * 0.98)).toBeLessThan(gap / 4);
  });

  it('every shader that reads depth back goes through the shared helpers', () => {
    for (const f of ['src/render/post.ts', 'src/render/screenfx.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src).toContain('${DEPTH_GLSL}');
      // No hand-written linearisation or comparisons against the cleared value: they assume one depth direction.
      expect(src).not.toMatch(/uNearFar\.y - uNearFar\.x/);
      expect(src).not.toMatch(/\bd >= 1\.0|\bd < 1\.0|0\.99999, dd|\) < 1\.0 \)/);
      // The depth texture is sampled in exactly one helper (depthAt or dAt), which snaps reads to texel centres.
      expect(src.match(/texture2D\( tDepth/g)?.length).toBe(1);
    }
  });
});

describe('coplanar offsets', () => {
  it('stacks polygon offset levels in a fixed order', () => {
    const levels = [COPLANAR.detail, COPLANAR.ground, COPLANAR.decal, COPLANAR.mark];
    const mats = levels.map((l) => coplanarOffset(new THREE.MeshBasicMaterial(), l));
    for (let i = 1; i < mats.length; i++) {
      expect(mats[i].polygonOffsetFactor).toBeLessThan(mats[i - 1].polygonOffsetFactor);
      expect(mats[i].polygonOffsetUnits).toBeLessThan(mats[i - 1].polygonOffsetUnits);
    }
    expect(mats.every((m) => m.polygonOffset)).toBe(true);
  });

  it('gives each crossing road layer its own depth pull, and keeps decals and tracks above them all', () => {
    const def = makeTerrainDef(legById('W'));
    const o = def.open!;
    const layers = o.roads.map((_, i) => roadLayer(o, i));
    const top = Math.max(...layers);
    expect(top).toBeGreaterThan(0);
    for (const reversed of [false, true]) {
      const pulls = [...new Set(layers)].sort((a, b) => a - b).map((l) => roadPull(l, reversed));
      for (let i = 1; i < pulls.length; i++) expect(pulls[i]).toBeGreaterThan(pulls[i - 1]);
      // One step is at least a centimetre at the distance the road and its neighbours are drawn from.
      const step = pullStep(reversed);
      expect(step * 300).toBeGreaterThan(reversed ? 0.01 : 0.05);
      // And never so much that something on the road sinks into it close by: 2 mm at 10 m for the top layer.
      expect(roadPull(top, reversed) * 10).toBeLessThan(0.02);
      expect(PULL.decal).toBeGreaterThan(PULL.road + top);
      expect(PULL.mark).toBeGreaterThan(PULL.decal);
    }
  });
});

const SIZES: Record<Exclude<Look, 'mall'>, [number, number][]> = {
  house: [[7, 8], [11, 9]],
  store: [[9, 16], [12, 10]],
  motel: [[9, 34]],
  barn: [[14, 24]],
  warehouse: [[20, 44], [24, 30]],
  shack: [[5, 6]],
  garage: [[8, 12]],
  dealership: [[14, 20]],
  tyreshop: [[8, 10]],
};

function parts(g: ReturnType<typeof buildBuildingGeometry>) {
  const out: { name: string; geo: THREE.BufferGeometry | null }[] = [];
  g.levels.forEach((lv, L) => out.push({ name: `L${L}.shell`, geo: lv.shell }, { name: `L${L}.trim`, geo: lv.trim }, { name: `L${L}.inside`, geo: lv.inside }, { name: `L${L}.glass`, geo: lv.glass ?? null }));
  out.push({ name: 'roof', geo: g.roof });
  return out;
}

/** Faces that can be seen, are in different colours, and share a plane over more than `big` square metres. */
function visibleFights(g: ReturnType<typeof buildBuildingGeometry>, big: number) {
  return coplanarOverlaps(parts(g), 2e-4, 4e-4, true).filter((h) => h.ca !== h.cb && h.n[1] > -0.9 && h.area > big);
}

describe('buildings draw no two faces in one plane', () => {
  it('generated buildings: walls, slabs, caps, plinths, roofs, stairs and furniture', () => {
    const bad: string[] = [];
    let floors2 = 0;
    for (const look of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
      SIZES[look].forEach(([w, d], i) => {
        for (let seed = 1; seed <= 3; seed++) {
          const floors = look === 'house' && seed % 2 === 0 ? 2 : 1;
          floors2 += floors > 1 ? 1 : 0;
          const plan = generatePlan({ x0: 100, x1: 100 + w, z0: 200, z1: 200 + d, look, door: seed % 2 ? 1 : -1, seed: seed * 31 + i, floors, floorY: 3, wear: (seed % 10) / 10, roof: 'gable' });
          const g = buildBuildingGeometry({ plan, extStyle: 14, tint: 0x888888, seed, look, roof: seed % 2 ? 'gable' : 'flat', ridgeX: true, door: 1, aabb: {} } as never);
          for (const h of visibleFights(g, 0.02)) bad.push(`${look} ${w}x${d} seed ${seed}: ${h.a}${h.ca} x ${h.b}${h.cb} n ${h.n.map((v) => v.toFixed(1))} at ${h.at.map((v) => v.toFixed(2))} (${(h.area * 1e4).toFixed(0)} cm2)`);
        }
      });
    }
    expect(floors2).toBeGreaterThan(0);
    expect(bad.slice(0, 6)).toEqual([]);
  });

  it('upper floor slabs stop inside the outer walls', () => {
    const plan = generatePlan({ x0: 0, x1: 9, z0: 0, z1: 10, look: 'house', door: 1, seed: 7, floors: 2, floorY: 0, wear: 0, roof: 'flat' });
    const g = buildBuildingGeometry({ plan, extStyle: 14, tint: 0x888888, seed: 7, look: 'house', roof: 'flat', ridgeX: true, door: 1, aabb: {} } as never);
    const box = new THREE.Box3().setFromBufferAttribute(g.levels[1].inside!.getAttribute('position') as THREE.BufferAttribute);
    expect(box.min.x).toBeGreaterThanOrEqual(plan.x0 + SLAB_INSET - 1e-3);
    expect(box.max.x).toBeLessThanOrEqual(plan.x1 - SLAB_INSET + 1e-3);
    expect(box.min.z).toBeGreaterThanOrEqual(plan.z0 + SLAB_INSET - 1e-3);
    expect(box.max.z).toBeLessThanOrEqual(plan.z1 - SLAB_INSET + 1e-3);
  });

  it('the Ofer mall: facade, parapet, sign box, roof and shop fittings', () => {
    const mall = new ChunkSource(legById('L3P')).layout.rural.find((b) => b.look === 'mall')!;
    const bad = visibleFights(buildBuildingGeometry(mall), 0.05).map((h) => `${h.a}${h.ca} x ${h.b}${h.cb} n ${h.n.map((v) => v.toFixed(1))} at ${h.at.map((v) => v.toFixed(2))} (${(h.area * 1e4).toFixed(0)} cm2)`);
    expect(bad.slice(0, 6)).toEqual([]);
  });
});
