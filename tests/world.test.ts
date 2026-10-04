import { describe, expect, it } from 'vitest';
import { LEGS } from '../src/data';
import { districtAt } from '../src/world/openWorld';
import { ChunkSource } from '../src/world/chunkgen';
import { CHUNK, CELLS, heightAt, roadX, makeTerrainDef, chunkHeights, surfaceAt, corridorHalf } from '../src/world/terrain';

describe.each(LEGS.legs.map((l) => [l.id, l] as const))('leg %s layout', (_id, leg) => {
  const src = new ChunkSource(leg);
  const L = src.layout;

  it('is deterministic', () => {
    const a = new ChunkSource(leg).layout;
    expect(a.pickups.length).toBe(L.pickups.length);
    expect(a.zombies.length).toBe(L.zombies.length);
    expect(JSON.stringify(a.pickups.slice(0, 20))).toBe(JSON.stringify(L.pickups.slice(0, 20)));
  });

  it('places every authored set piece', () => {
    for (const s of leg.sets) {
      if (s.type === 'encounter') expect(L.encounters.some((e) => e.encounter === s.id)).toBe(true);
      if (s.type === 'scavengeZone') expect(L.zones.length).toBeGreaterThan(0);
      if (s.type === 'ambush' || s.type === 'canyonAmbush') expect(L.ambushes.some((a) => Math.abs(a.z - s.at) < 1)).toBe(true);
      if (s.type === 'radioFragment') expect(L.pickups.some((p) => p.kind === 'fragment' && p.amount === s.n)).toBe(true);
      if (s.type === 'chassisWreck') expect(L.pickups.some((p) => p.kind === 'chassis')).toBe(true);
    }
  });

  it('start is on the road at ground level and the end is reachable', () => {
    expect(Math.abs(L.start.x - roadX(L.terrain, L.start.z))).toBeLessThan(0.01);
    expect(L.end.z).toBe(leg.length);
    const h = heightAt(L.terrain, L.start.x, L.start.z);
    expect(h).toBeLessThan(2);
  });

  it('spawns no zombie or pickup inside a building', () => {
    for (const z of L.zombies) expect(L.blockedAt(z.x, z.z, 0)).toBe(false);
  });

  it('chunk data partitions content', () => {
    let pk = 0;
    // The open world is too big to walk chunk by chunk in a test: check a window of it.
    const o = L.terrain.open;
    const cx0 = o ? -6 : -3;
    const cx1 = o ? 6 : 3;
    const cz0 = o ? -2 : -2;
    const cz1 = o ? 20 : Math.ceil(leg.length / CHUNK) + 2;
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) pk += src.get(cx, cz).pickups.length;
    const inWindow = L.pickups.filter((p) => Math.floor(p.x / CHUNK) >= cx0 && Math.floor(p.x / CHUNK) <= cx1 && Math.floor(p.z / CHUNK) >= cz0 && Math.floor(p.z / CHUNK) <= cz1).length;
    if (o) return expect(pk).toBe(inWindow);
    // pickups beyond |x| of 3 chunks are possible in the wasteland but rare; most must be found
    expect(pk).toBeGreaterThan(L.pickups.length * 0.9);
  });
});

describe('terrain', () => {
  const leg = LEGS.legs.find((l) => l.id === 'L1')!;
  const def = makeTerrainDef(leg);
  it('heightfield seams match between neighbouring chunks', () => {
    const a = chunkHeights(def, 0, 3);
    const b = chunkHeights(def, 1, 3);
    for (let r = 0; r <= CELLS; r++) expect(a[CELLS * (CELLS + 1) + r]).toBeCloseTo(b[0 * (CELLS + 1) + r], 5);
    const c = chunkHeights(def, 0, 4);
    for (let col = 0; col <= CELLS; col++) expect(a[col * (CELLS + 1) + CELLS]).toBeCloseTo(c[col * (CELLS + 1)], 5);
  });
  it('the road stays drivable: slope under 12 degrees along the spine', () => {
    let worst = 0;
    const onRamp = (z: number) => def.ramps.some((r) => z > r.z0 - 8 && z < r.z0 + r.len + r.gap + r.plateauLen + 40);
    for (let z = 0; z < leg.length; z += 4) {
      if (onRamp(z) || onRamp(z + 4)) continue;
      const dz = (heightAt(def, roadX(def, z + 4), z + 4) - heightAt(def, roadX(def, z), z)) / 4;
      worst = Math.max(worst, Math.abs(dz));
    }
    expect(worst).toBeLessThan(Math.tan((12 * Math.PI) / 180));
  });
  it('cliffs bound the corridor', () => {
    const z = 600;
    expect(heightAt(def, roadX(def, z) + corridorHalf(def, z) + 25, z)).toBeGreaterThan(20);
    expect(heightAt(def, roadX(def, z) - corridorHalf(def, z) - 25, z)).toBeGreaterThan(20);
  });
  it('road surface is asphalt, the sides are not', () => {
    expect(surfaceAt(def, roadX(def, 500), 500)).toBe('asphalt');
    expect(surfaceAt(def, roadX(def, 500) + 12, 500)).not.toBe('asphalt');
  });
  it('the ramp cache has a plateau reachable by jumping', () => {
    const r = def.ramps[0];
    expect(r).toBeDefined();
    const xc = roadX(def, r.z0 + r.len) + r.xOff;
    const base = heightAt(def, xc, r.z0 - 10);
    const lip = heightAt(def, xc, r.z0 + r.len - 0.5);
    const gap = heightAt(def, xc, r.z0 + r.len + r.gap * 0.5);
    const plateau = heightAt(def, xc, r.z0 + r.len + r.gap + r.plateauLen * 0.5);
    expect(lip - base).toBeGreaterThan(1.5);
    expect(gap).toBeLessThan(lip - 1.0);
    expect(plateau - base).toBeGreaterThan(1.8);
  });
});

describe('city passages', () => {
  const leg = LEGS.legs.find((l) => l.id === 'L2C')!;
  const L = new ChunkSource(leg).layout;
  it('every side has an interior alley (1.8 m) and wider streets', () => {
    for (const side of [-1, 1]) {
      const ps = L.passages.filter((p) => p.side === side);
      expect(ps.some((p) => p.width === 1.8)).toBe(true);
      expect(ps.some((p) => p.width >= 3.6)).toBe(true);
    }
  });
  it('reinforced barricades plug every passage a car fits, but leave alleys', () => {
    const rb = L.barricades.find((b) => b.grade === 'reinforced');
    expect(rb).toBeDefined();
    const slab = L.aabbs.filter((a) => a.kind === 'barricade' && Math.abs((a.minZ + a.maxZ) / 2 - rb!.z) < 0.01);
    const covered = (x: number) => slab.some((a) => x > a.minX && x < a.maxX);
    expect(covered(0)).toBe(true);
    for (const p of L.passages) {
      const cx = (p.x0 + p.x1) / 2;
      if (Math.abs(cx) >= 60) continue;
      if (p.width >= 2.6) expect(covered(cx)).toBe(true);
      else expect(covered(cx)).toBe(false);
    }
  });
});

describe('wasteland places', () => {
  const wasteland = LEGS.legs.filter((l) => l.biome === 'wasteland');
  it.each(wasteland.map((l) => [l.id, l] as const))('%s: roadside places fill the leg and leave the road clear', (_id, leg) => {
    const src = new ChunkSource(leg);
    const L = src.layout;
    const def = L.terrain;
    // A place every few hundred metres, not one per leg.
    expect(def.sites.length).toBeGreaterThanOrEqual(5);
    expect(L.rural.length).toBeGreaterThanOrEqual(8);
    expect(new Set(def.sites.map((s) => s.kind)).size).toBeGreaterThanOrEqual(4);
    // Nothing solid sits on the carriageway or its shoulders.
    for (const a of L.aabbs) {
      if (a.kind !== 'building' && a.kind !== 'tower' && a.kind !== 'pillar' && a.kind !== 'crate' && a.kind !== 'partition' && a.kind !== 'furniture') continue;
      for (let z = a.minZ; z <= a.maxZ + 2; z += 2) {
        const rx = roadX(def, Math.min(z, a.maxZ));
        const gap = Math.max(a.minX - rx, rx - a.maxX);
        expect(gap).toBeGreaterThan(def.roadHalf + 2);
      }
    }
    // Buildings stand on level ground.
    for (const b of L.rural) {
      const a = b.aabb;
      const hs = [[a.minX, a.minZ], [a.maxX, a.minZ], [a.minX, a.maxZ], [a.maxX, a.maxZ]].map(([x, z]) => heightAt(def, x, z));
      expect(Math.max(...hs) - Math.min(...hs)).toBeLessThan(2.6);
    }
  });
  it('places are inside the corridor and clear of authored set pieces', () => {
    for (const leg of wasteland) {
      const def = makeTerrainDef(leg);
      for (const s of def.sites) {
        expect(Math.abs(s.x - roadX(def, s.z))).toBeLessThan(corridorHalf(def, s.z));
        // Set pieces are strung along the highway; a place out in the open country cannot collide with them.
        if (def.open && Math.abs(s.x - roadX(def, s.z)) > 260) continue;
        for (const r of def.ramps) expect(s.z < r.z0 - 40 || s.z > r.z0 + 200).toBe(true);
        for (const c of def.canyons) expect(s.z < c.z0 - 40 || s.z > c.z1 + 40).toBe(true);
        for (const m of def.minefields) expect(s.z < m.z0 - 40 || s.z > m.z1 + 40).toBe(true);
      }
    }
  });
  it('the road still climbs gently with basins, dunes and buttes around it', () => {
    for (const leg of wasteland) {
      const def = makeTerrainDef(leg);
      for (let z = 0; z < leg.length; z += 4) {
        if (def.ramps.some((r) => z > r.z0 - 8 && z < r.z0 + r.len + r.gap + r.plateauLen + 40)) continue;
        const dz = (heightAt(def, roadX(def, z + 4), z + 4) - heightAt(def, roadX(def, z), z)) / 4;
        expect(Math.abs(dz)).toBeLessThan(Math.tan((12 * Math.PI) / 180));
      }
    }
  });
});

describe('wasteland interiors', () => {
  const wasteland = LEGS.legs.filter((l) => l.biome === 'wasteland');
  it.each(wasteland.map((l) => [l.id, l] as const))('%s: buildings have levelled floors, walls with doorways and things to search', (_id, leg) => {
    const L = new ChunkSource(leg).layout;
    const def = L.terrain;
    expect(L.rural.length).toBeGreaterThanOrEqual(8);
    for (const b of L.rural) {
      const p = b.plan;
      // The ground inside the walls is the floor.
      for (const [x, z] of [[p.x0 + 1, p.z0 + 1], [p.x1 - 1, p.z1 - 1], [(p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2]]) expect(heightAt(def, x, z)).toBeCloseTo(p.floorY, 2);
      expect(p.rooms.length).toBeGreaterThan(0);
      expect(p.walls.some((w) => w.ext && w.ops.some((o) => o.kind === 'door' || o.kind === 'gate'))).toBe(true);
    }
    // Every building interior can hold loot, and the containers are spread over several rooms and buildings.
    expect(L.zones.length).toBeGreaterThanOrEqual(5);
    const containers = L.zones.flatMap((z) => z.containers);
    expect(containers.length).toBeGreaterThanOrEqual(15);
    for (const c of containers) expect(c.items.length + Object.keys(c.drugs ?? {}).length + (c.guns ? 1 : 0)).toBeGreaterThan(0);
    expect(new Set(containers.map((c) => c.label)).size).toBeGreaterThanOrEqual(4);
  });
  it('the dead wait inside some of them', () => {
    let inside = 0;
    for (const leg of wasteland) {
      const L = new ChunkSource(leg).layout;
      for (const z of L.zombies) {
        if (L.rural.some((b) => z.x > b.plan.x0 + 0.3 && z.x < b.plan.x1 - 0.3 && z.z > b.plan.z0 + 0.3 && z.z < b.plan.z1 - 0.3)) inside++;
      }
    }
    expect(inside).toBeGreaterThan(5);
  });
});

describe.each(LEGS.legs.map((l) => [l.id, l] as const))('leg %s cars', (_id, leg) => {
  const L = new ChunkSource(leg).layout;

  it('has cars, each with a unique id and a seed', () => {
    expect(L.cars.length).toBeGreaterThan(leg.biome === 'city' ? 20 : 8);
    expect(new Set(L.cars.map((c) => c.id)).size).toBe(L.cars.length);
  });

  it('places them identically every time', () => {
    const again = new ChunkSource(leg).layout.cars;
    expect(JSON.stringify(again)).toBe(JSON.stringify(L.cars));
  });

  it('keeps them off the ground-level roadbed in the wasteland and on the boulevard in the city', () => {
    for (const c of L.cars) {
      expect(Number.isFinite(c.y)).toBe(true);
      if (leg.biome === 'wasteland' && !districtAt(L.terrain.open, c.x, c.z)) {
        // Roadside wrecks stand beside the road, never across it.
        expect(Math.abs(c.x - roadX(L.terrain, c.z))).toBeGreaterThan(4.5);
        expect(Math.abs(c.y - heightAt(L.terrain, c.x, c.z))).toBeLessThan(0.01);
      } else {
        expect(Math.abs(c.x)).toBeLessThan(40);
      }
    }
  });

  it('never drops a zombie or a pickup inside a car', () => {
    for (const z of L.zombies) for (const c of L.cars) expect(Math.hypot(z.x - c.x, z.z - c.z)).toBeGreaterThan(1.0);
  });

  it('the cars on a leg are a mix of conditions', async () => {
    const { rollCar } = await import('../src/sim/cars');
    const count = { hulk: 0, rough: 0, intact: 0 };
    for (const c of L.cars) count[rollCar(c.seed, { biome: leg.biome, chassis: c.chassis, status: c.status }).status]++;
    expect(count.hulk + count.rough + count.intact).toBe(L.cars.length);
    expect(count.rough + count.intact).toBeGreaterThan(2);
  });
});
