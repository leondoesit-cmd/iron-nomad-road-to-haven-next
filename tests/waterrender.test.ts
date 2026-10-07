import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { legById } from '../src/data';
import { makeTerrainDef, type TerrainDef } from '../src/world/terrain';
import { fallsGeometry, riverRibbonGeometry, waterfallSpots, buildRiverWater, RIBBON_NX } from '../src/render/riverWater';
import { buildSpringWater, buildSwampWater, springGeometry } from '../src/render/water';
import { bridge } from '../src/render/waterProps';
import { bridgeTag } from '../src/world/hydro';

let def: TerrainDef;
beforeAll(() => {
  def = makeTerrainDef(legById('W'));
});

const finite = (a: ArrayLike<number>) => {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
};

describe('river and stream water', () => {
  it('lays a ribbon along every course, at its levels', () => {
    const rib = riverRibbonGeometry(def)!;
    const hy = def.hydro!;
    expect(rib.courses.length).toBe(hy.rivers.length);
    const pos = rib.geometry.getAttribute('position');
    for (const c of rib.courses) {
      const r = hy.rivers[c.river];
      expect(c.rows).toBeGreaterThan(r.end);
      // Up to where the course runs into other water, every vertex of a cross-section sits on that sample's level.
      for (let i = 0; i < r.end - 2; i++) {
        for (let k = 0; k < RIBBON_NX; k++) {
          const y = pos.getY(c.first + i * RIBBON_NX + k);
          if (r.spring >= 0 && Math.hypot(r.x[i] - hy.springs[r.spring].x, r.z[i] - hy.springs[r.spring].z) < hy.springs[r.spring].r + 2) continue;
          expect(Math.abs(y - r.level[i])).toBeLessThan(1e-3);
        }
      }
    }
    for (const name of ['position', 'aFlow', 'aDir', 'aFade', 'aRise']) expect(finite(rib.geometry.getAttribute(name).array as Float32Array)).toBe(true);
    expect(rib.geometry.boundingSphere!.radius).toBeGreaterThan(1000);
  });

  it('leaves the falls out of the ribbon and gives them a steep sheet', () => {
    const hy = def.hydro!;
    const rib = riverRibbonGeometry(def)!;
    const idx = rib.geometry.index!.array;
    // Which segments (course, first sample) the ribbon draws.
    const drawn = new Set<string>();
    for (let t = 0; t < idx.length; t += 3) {
      const v = Math.min(idx[t], idx[t + 1], idx[t + 2]);
      const c = rib.courses.find((q) => v >= q.first && v < q.first + q.rows * RIBBON_NX)!;
      drawn.add(`${c.river}:${Math.floor((v - c.first) / RIBBON_NX)}`);
    }
    const fg = fallsGeometry(def)!;
    expect(finite(fg.getAttribute('position').array as Float32Array)).toBe(true);
    expect(finite(fg.getAttribute('normal').array as Float32Array)).toBe(true);
    const pos = fg.getAttribute('position');
    const fa = fg.getAttribute('aFall');
    for (const f of hy.falls) {
      // No ribbon quad spans the drop; the water either side of it is drawn.
      for (let i = f.i0; i < f.i1; i++) expect(drawn.has(`${f.river}:${i}`)).toBe(false);
      expect(drawn.has(`${f.river}:${f.i0 - 1}`)).toBe(true);
      expect(drawn.has(`${f.river}:${f.i1}`)).toBe(true);
      // The sheet: the vertices of this fall (kind 0) near its lip, steeper than the threshold a course calls a fall.
      let top = -Infinity;
      let bottom = Infinity;
      for (let v = 0; v < pos.count; v++) {
        if (fa.getW(v) !== 0) continue;
        if (Math.hypot(pos.getX(v) - f.x, pos.getZ(v) - f.z) > (f.i1 - f.i0) * 3 + f.half * 1.3 + 1) continue;
        top = Math.max(top, pos.getY(v));
        bottom = Math.min(bottom, pos.getY(v));
      }
      expect(top).toBeCloseTo(f.top, 1);
      expect(bottom).toBeCloseTo(f.bottom, 1);
      expect((top - bottom) / ((f.i1 - f.i0) * 3)).toBeGreaterThan(0.35);
    }
  });

  it('marks every fall for the mist and the sound', () => {
    const spots = waterfallSpots(def.hydro!);
    expect(spots.length).toBe(def.hydro!.falls.length);
    const tall = spots.filter((s) => s.height > 30);
    expect(tall.length).toBe(3);
    for (const s of spots) {
      expect(s.lip[1] - s.foot[1]).toBeCloseTo(s.height, 3);
      expect(s.sprayH).toBeGreaterThan(0.5);
    }
  });

  it('builds two meshes with materials and frees them', () => {
    const w = buildRiverWater(def)!;
    expect(w.river).toBeTruthy();
    expect(w.falls).toBeTruthy();
    expect(w.group.children.length).toBe(2);
    expect((w.river!.material as THREE.Material).transparent).toBe(true);
    w.dispose();
  });
});

describe('swamps and springs', () => {
  it('builds a sheet per swamp at its level', () => {
    for (const s of def.hydro!.swamps) {
      const w = buildSwampWater(def, s);
      expect(w.mesh.position.y).toBe(s.level);
      expect(w.mesh.geometry.boundingSphere).toBeTruthy();
      w.dispose();
    }
  });

  it('builds every spring pool in one mesh, deepest in the middle', () => {
    const hy = def.hydro!;
    const g = springGeometry(def, hy.springs)!;
    const pool = g.getAttribute('aPool');
    const pos = g.getAttribute('position');
    expect(finite(pool.array as Float32Array)).toBe(true);
    // Each pool's first vertex is its centre: water there, at the pool's level.
    const per = pos.count / hy.springs.length;
    hy.springs.forEach((sp, k) => {
      expect(pos.getY(k * per)).toBeCloseTo(sp.level, 4);
      expect(pool.getX(k * per)).toBeGreaterThan(0.5);
    });
    const w = buildSpringWater(def, hy.springs)!;
    expect(w.mesh).toBeTruthy();
    w.dispose();
  });
});

describe('bridges', () => {
  it('stands the headwall clear of the causeway slope, down to the bed', () => {
    const half = 7;
    const drop = 6.7;
    const b = bridge(1, bridgeTag(25, drop, half));
    let xMax = 0;
    let yMin = 0;
    for (let i = 0; i < b.pos.length; i += 3) {
      xMax = Math.max(xMax, Math.abs(b.pos[i]));
      yMin = Math.min(yMin, b.pos[i + 1]);
    }
    // The causeway is down to the channel 4.4 m past the road edge; the terrain's 2 m cells smear that a little further.
    expect(xMax).toBeGreaterThan(half + 5.3);
    expect(yMin).toBeLessThan(-drop);
  });
});
