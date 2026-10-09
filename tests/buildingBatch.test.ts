import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { legById } from '../src/data';
import { takePlan } from '../src/world/planCache';
import { Landscape } from '../src/render/landscape';
import { buildBuildingGeometry, type BuildingView } from '../src/render/buildingView';
import { BATCH_FAR } from '../src/render/buildingBatch';

/** Every triangle of a geometry within its draw range, as flat vertex data (all attributes, index resolved). */
function triangles(g: THREE.BufferGeometry): number[] {
  const out: number[] = [];
  const idx = g.index!;
  const start = g.drawRange.start;
  const end = Math.min(idx.count, start + g.drawRange.count);
  const names = Object.keys(g.attributes).sort();
  for (let i = start; i < end; i++) {
    const v = idx.getX(i);
    for (const k of names) {
      const a = g.attributes[k] as THREE.BufferAttribute;
      for (let c = 0; c < a.itemSize; c++) out.push(a.array[v * a.itemSize + c]);
    }
  }
  return out;
}

describe('far building batches', () => {
  const src = takePlan(legById('W'));
  const land = new Landscape(src.layout.terrain, src.layout, src.cityBuildings());
  const group = land.group.children.find((o) => o.name === 'buildingBatches')!;
  const batches = group.children as THREE.Mesh[];
  const owners = new Map<THREE.BufferAttribute, THREE.Mesh>();
  for (const m of batches) owners.set(m.geometry.attributes.position as THREE.BufferAttribute, m);
  const batchOf = (b: BuildingView) => b.exterior.kit.map((m) => owners.get(m.geometry.attributes.position as THREE.BufferAttribute)).find(Boolean);

  it('draws each building from its own slice of the shared buffers, triangle for triangle what it was', () => {
    expect(land.buildings.length).toBeGreaterThan(50);
    expect(batches.length).toBeGreaterThan(5);
    let checked = 0;
    for (const b of land.buildings.slice(0, 40)) {
      const fresh = buildBuildingGeometry(b.rb);
      const want = {
        facade: fresh.levels.map((l) => l.shell).filter(Boolean) as THREE.BufferGeometry[],
        kit: [...(fresh.levels.map((l) => l.trim).filter(Boolean) as THREE.BufferGeometry[]), ...(fresh.roof ? [fresh.roof] : [])],
      };
      for (const kind of ['facade', 'kit'] as const) {
        const meshes = b.exterior[kind];
        expect(meshes.length).toBe(want[kind].length);
        meshes.forEach((m, i) => {
          expect(triangles(m.geometry)).toEqual(triangles(want[kind][i]));
          checked++;
        });
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('swaps a cell to its batch only for a camera far from every building in it, and back', () => {
    const b = land.buildings.find((x) => batchOf(x))!;
    const batch = batchOf(b)!;
    const cellMates = land.buildings.filter((x) => batchOf(x) === batch);
    expect(cellMates.length).toBeGreaterThan(1);
    const far = 5000;
    land.updateView(null, b.cx + far, 2, b.cz + far);
    expect(batch.visible).toBe(true);
    for (const x of cellMates) for (const m of [...x.exterior.facade, ...x.exterior.kit]) expect(m.visible).toBe(false);
    land.updateView(null, b.cx, 2, b.cz + BATCH_FAR + b.radius - 1);
    expect(batch.visible).toBe(false);
    for (const x of cellMates) for (const m of [...x.exterior.facade, ...x.exterior.kit]) expect(m.visible).toBe(true);
  });

  it('stops batching a cell when one of its buildings is rebuilt, without freeing buffers its neighbours draw from', () => {
    const b = land.buildings.find((x) => batchOf(x))!;
    const batch = batchOf(b)!;
    const mate = land.buildings.find((x) => x !== b && batchOf(x) === batch)!;
    let freed = 0;
    batch.geometry.addEventListener('dispose', () => freed++);
    const shared = batch.geometry.attributes.position;
    b.rebuild();
    expect(freed).toBe(0);
    expect(mate.exterior.kit.some((m) => m.geometry.attributes.position === shared)).toBe(true);
    land.updateView(null, b.cx + 5000, 2, b.cz + 5000);
    expect(batch.visible).toBe(false);
    for (const m of [...b.exterior.facade, ...b.exterior.kit, ...mate.exterior.kit]) expect(m.visible).toBe(true);
    // The rebuilt building has buffers of its own again.
    for (const m of b.exterior.kit) expect(m.geometry.attributes.position).not.toBe(shared);
    land.dispose();
    expect(freed).toBe(1);
  });
});
