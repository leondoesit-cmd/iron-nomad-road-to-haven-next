import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ParticleLayer, Tracers } from '../src/render/particles';
import { foundationsAt } from '../src/world/foundationIndex';
import { baseHeight, makeTerrainDef, type Foundation } from '../src/world/terrain';
import { legById } from '../src/data';

const emit = (layer: ParticleLayer, life = 1, blood = false) => layer.emit(1, 2, 3, 4, 5, 6, life, 0.5, 2, 1, 0.2, 0.1, 0.8, 9.81, 0.5, blood);
const attributes = (geo: THREE.BufferGeometry) => Object.values(geo.attributes) as THREE.BufferAttribute[];
const uploaded = (geo: THREE.BufferGeometry) => attributes(geo).forEach(a => a.clearUpdateRanges());

describe('particle work follows live effects', () => {
  it('empty pools and expired pools stop uploading buffers and submitting vertices', () => {
    const layer = new ParticleLayer(3000, false);
    const geo = layer.points.geometry;
    const initial = attributes(geo).map(a => a.version);
    layer.update(1 / 60);
    expect(attributes(geo).map(a => a.version)).toEqual(initial);
    expect(geo.drawRange.count).toBe(0);
    emit(layer, 0.02);
    layer.update(0.01);
    expect(geo.drawRange).toEqual({ start: 0, count: 1 });
    expect(geo.getAttribute('position').getX(0)).toBeGreaterThan(1);
    expect((geo.getAttribute('position') as THREE.BufferAttribute).updateRanges).toEqual([{ start: 0, count: 3 }]);
    layer.update(0.02);
    expect(geo.drawRange.count).toBe(0);
    expect(geo.getAttribute('aColor').getW(0)).toBe(0);
    const expired = attributes(geo).map(a => a.version);
    layer.update(1);
    expect(attributes(geo).map(a => a.version)).toEqual(expired);
  });
  it('recycling preserves slot order, removes dead holes, and changes blood only on emission', () => {
    const layer = new ParticleLayer(4, false);
    emit(layer, 0.01, true); emit(layer, 1); emit(layer, 0.01); emit(layer, 1);
    layer.update(0.02);
    const geo = layer.points.geometry;
    expect(geo.drawRange).toEqual({ start: 1, count: 3 });
    expect(geo.getAttribute('aSize').getX(2)).toBe(0);
    uploaded(geo);
    const blood = geo.getAttribute('aBlood') as THREE.BufferAttribute;
    const version = blood.version;
    layer.update(0.01);
    expect(blood.version).toBe(version);
    emit(layer, 1, false); // Wraps to slot 0, formerly blood.
    layer.update(0.01);
    expect(geo.drawRange).toEqual({ start: 0, count: 4 });
    expect(blood.getX(0)).toBe(0);
    expect(blood.updateRanges).toEqual([{ start: 0, count: 1 }]);
    expect(geo.getAttribute('aColor').getW(0)).toBeGreaterThan(0);
  });
  it('accumulates dirty ranges across updates until the renderer consumes them', () => {
    const layer = new ParticleLayer(4, false);
    emit(layer); layer.update(0.01);
    emit(layer); layer.update(0.01);
    const ranges = (layer.points.geometry.getAttribute('position') as THREE.BufferAttribute).updateRanges;
    expect(ranges).toEqual([{ start: 0, count: 3 }, { start: 0, count: 6 }]);
  });
  it('stationary tracer endpoints upload only when added or retired', () => {
    const tracers = new Tracers(4), geo = tracers.mesh.geometry;
    tracers.update(0.01);
    expect(geo.drawRange.count).toBe(0);
    tracers.add(0, 0, 0, 1, 2, 3, 1, 1, 1, 0.1);
    tracers.update(0.01);
    expect(geo.drawRange).toEqual({ start: 0, count: 2 });
    const position = geo.getAttribute('position') as THREE.BufferAttribute;
    const version = position.version;
    uploaded(geo); tracers.update(0.01);
    expect(position.version).toBe(version);
    tracers.update(0.2);
    expect(position.version).toBeGreaterThan(version);
    expect(Array.from(position.array.slice(0, 6))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(geo.drawRange.count).toBe(0);
  });
});

describe('foundation spatial lookup', () => {
  const pads = (): Foundation[] => Array.from({ length: 200 }, (_, i) => ({ x0: (i % 20) * 64 - 640, x1: (i % 20) * 64 - 610, z0: Math.floor(i / 20) * 64 - 320, z1: Math.floor(i / 20) * 64 - 292, h: i % 7 }));
  const affects = (f: Foundation, x: number, z: number) => z >= f.z0 - 3.5 && z <= f.z1 + 3.5 && x >= f.x0 - 3.5 && x <= f.x1 + 3.5;
  it('returns every overlapping pad in its original order, including negative coordinates and cell boundaries', () => {
    const foundations = pads();
    foundations.push({ x0: -32, x1: 64, z0: -32, z1: 64, h: 9 });
    for (let x = -700; x <= 700; x += 15.5) for (let z = -350; z <= 350; z += 17) {
      expect(foundationsAt(foundations, x, z).filter(f => affects(f, x, z))).toEqual(foundations.filter(f => affects(f, x, z)));
    }
    for (const f of foundations) for (const x of [f.x0 - 3.5, f.x1 + 3.5]) for (const z of [f.z0 - 3.5, f.z1 + 3.5])
      expect(foundationsAt(foundations, x, z)).toContain(f);
    expect(foundationsAt(foundations, 10000, 10000)).toHaveLength(0);
  });
  it('picks up new foundations during settlement construction and can rebuild after truncation', () => {
    const foundations = pads();
    expect(foundationsAt(foundations, 5000, 5000)).toHaveLength(0);
    const added = { x0: 4990, x1: 5010, z0: 4990, z1: 5010, h: 2 };
    foundations.push(added);
    expect(foundationsAt(foundations, 5000, 5000)).toContain(added);
    foundations.length = 16;
    expect(foundationsAt(foundations, 5000, 5000)).not.toContain(added);
  });
  it('produces exactly the same terrain heights as applying all relevant pads directly', () => {
    const def = makeTerrainDef(legById('L1'));
    def.foundations = pads();
    for (let x = -660; x < 660; x += 29.5) for (let z = -340; z < 340; z += 27) {
      const local = def.foundations.filter(f => affects(f, x, z));
      expect(baseHeight(def, x, z)).toBe(baseHeight({ ...def, foundations: local }, x, z));
    }
  });
});
