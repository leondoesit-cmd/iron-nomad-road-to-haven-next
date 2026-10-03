import { describe, expect, it } from 'vitest';
import { legById } from '../src/data';
import { heightAt, makeTerrainDef, roadX, surfaceAt } from '../src/world/terrain';
import { districtAt, nearestRoad } from '../src/world/openWorld';

const leg = legById('W');
const def = makeTerrainDef(leg);

describe('open world terrain', () => {
  it('has a district for Petah Tikva a short drive north of the start', () => {
    const d = def.open!.districts[0];
    console.log('district', JSON.stringify(d), 'hubs', JSON.stringify(def.open!.hubs), 'sites', def.sites.length, 'lakes', def.lakes.length, 'roads', def.open!.roads.length);
    expect(d.z0).toBeGreaterThan(200);
    expect(d.z0).toBeLessThan(500);
  });
  it('keeps the highway straight and level through the city', () => {
    const d = def.open!.districts[0];
    for (let z = d.z0; z < d.z1; z += 37) {
      expect(Math.abs(roadX(def, z))).toBe(0);
      expect(heightAt(def, 0, z)).toBeCloseTo(0, 5);
    }
  });
  it('is open ground away from the highway', () => {
    for (const [x, z] of [[900, 200], [-1200, 800], [1500, 3000], [-1800, -900]]) {
      const h = heightAt(def, x, z);
      expect(Number.isFinite(h)).toBe(true);
      expect(Math.abs(h)).toBeLessThan(60);
    }
    expect(districtAt(def.open, 0, 1000)).not.toBeNull();
    expect(districtAt(def.open, 900, 1000)).toBeNull();
    expect(surfaceAt(def, roadX(def, 3000), 3000)).toBe('asphalt');
    expect(nearestRoad(def.open!, roadX(def, 3000) + 2, 3000).road?.kind).toBe('highway');
  });
  it('walls the map in', () => {
    expect(heightAt(def, 2300 + 40, 1000)).toBeGreaterThan(25);
    expect(heightAt(def, 0, -1400 - 40)).toBeGreaterThan(25);
    expect(heightAt(def, 0, 4300 + 40)).toBeGreaterThan(25);
  });
});

import { ChunkSource } from '../src/world/chunkgen';
describe('open world layout', () => {
  const t0 = performance.now();
  const src = new ChunkSource(leg);
  const L = src.layout;
  console.log('layout ms', Math.round(performance.now() - t0), 'props', L.props.length, 'aabbs', L.aabbs.length, 'cars', L.cars.length, 'zombies', L.zombies.length, 'pickups', L.pickups.length, 'zones', L.zones.length, 'lots', L.lots.length, 'rural', L.rural.length);
  it('has the city in it', () => {
    expect(L.lots.length).toBeGreaterThan(100);
    expect(L.streets.length).toBeGreaterThan(20);
    const mid = src.get(0, 8);
    expect(mid.city).toBe(true);
    expect(mid.buildings.length + src.get(-1, 8).buildings.length).toBeGreaterThan(2);
    expect(src.get(8, 0).city).toBe(false);
  });
});
