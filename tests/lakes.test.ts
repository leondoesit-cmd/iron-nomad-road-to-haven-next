import { describe, expect, it } from 'vitest';
import { LEGS } from '../src/data';
import { corridorHalf, groundHeight, heightAt, makeTerrainDef, roadX, surfaceAt, waterAt } from '../src/world/terrain';
import { dockDeckAt, lakeQ } from '../src/world/lakes';
import { courseAt } from '../src/world/hydro';

const wasteland = LEGS.legs.filter((l) => l.biome === 'wasteland');

describe.each(wasteland.map((l) => [l.id, l] as const))('lakes on %s', (_id, leg) => {
  const def = makeTerrainDef(leg);

  it('plans at least one lake with an island and a dock', () => {
    expect(def.lakes.length).toBeGreaterThanOrEqual(1);
    for (const l of def.lakes) {
      expect(l.islands.length).toBeGreaterThanOrEqual(1);
      expect(l.dock).not.toBeNull();
      expect(l.dock!.boats.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('is deterministic', () => {
    const again = makeTerrainDef(leg);
    expect(JSON.stringify(again.lakes)).toBe(JSON.stringify(def.lakes));
  });

  it('keeps every shore well clear of the carriageway', () => {
    for (const l of def.lakes) {
      for (let a = 0; a < 360; a += 6) {
        const th = (a * Math.PI) / 180;
        for (let rr = l.r * 0.2; rr < l.reach; rr += 6) {
          const x = l.x + Math.cos(th) * rr;
          const z = l.z + Math.sin(th) * rr;
          if (lakeQ(l, x, z) < 1.45) expect(Math.abs(x - roadX(def, z))).toBeGreaterThan(40);
        }
      }
    }
  });

  it('fits between the cliffs', () => {
    for (const l of def.lakes) {
      for (let a = 0; a < 360; a += 10) {
        const th = (a * Math.PI) / 180;
        for (let rr = 0; rr < l.reach; rr += 8) {
          const x = l.x + Math.cos(th) * rr;
          const z = l.z + Math.sin(th) * rr;
          if (lakeQ(l, x, z) < 1.2) expect(Math.abs(x - roadX(def, z))).toBeLessThan(corridorHalf(def, z) - 25);
        }
      }
    }
  });

  it('holds water: the floor is under the level everywhere inside the shore, and the rim stays above it', () => {
    for (const l of def.lakes) {
      let wet = 0;
      for (let a = 0; a < 360; a += 5) {
        const th = (a * Math.PI) / 180;
        for (let rr = 1; rr < l.reach; rr += 3) {
          const x = l.x + Math.cos(th) * rr;
          const z = l.z + Math.sin(th) * rr;
          const q = lakeQ(l, x, z);
          const h = heightAt(def, x, z);
          // A river or stream may cut the rim where it runs in: its own water meets the lake's there.
          const running = q > 1.0 && def.hydro && courseAt(def.hydro, x, z, 2);
          if (q > 1.0 && q < 1.2 && !running) expect(h).toBeGreaterThanOrEqual(l.level - 1e-6);
          if (q < 1) {
            const w = waterAt(def, x, z);
            if (w) {
              wet++;
              expect(w.depth).toBeGreaterThan(0);
              expect(h).toBeLessThan(l.level);
            }
          }
        }
      }
      expect(wet).toBeGreaterThan(200);
    }
  });

  it('islands break the surface, with a beach to wade onto', () => {
    for (const l of def.lakes) {
      for (const i of l.islands) {
        expect(heightAt(def, i.x, i.z)).toBeGreaterThan(l.level + 1);
        expect(waterAt(def, i.x, i.z)).toBeNull();
        // Walking out from the summit in any direction reaches water.
        let wet = 0;
        for (let a = 0; a < 360; a += 45) {
          const th = (a * Math.PI) / 180;
          if (waterAt(def, i.x + Math.cos(th) * i.r * 3, i.z + Math.sin(th) * i.r * 3)) wet++;
        }
        expect(wet).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it('docks reach deep water and stand on dry land at the shore', () => {
    for (const l of def.lakes) {
      const d = l.dock!;
      const tipX = d.shoreX + d.dx * (d.len - 1);
      const tipZ = d.shoreZ + d.dz * (d.len - 1);
      const w = waterAt(def, tipX, tipZ);
      expect(w).not.toBeNull();
      expect(w!.depth).toBeGreaterThan(1.2);
      expect(waterAt(def, d.shoreX - d.dx * 3, d.shoreZ - d.dz * 3)).toBeNull();
      expect(dockDeckAt(def.lakes, tipX, tipZ)).toBeCloseTo(d.deckY);
      expect(groundHeight(def, tipX, tipZ)).toBeCloseTo(d.deckY);
      // The walk from the beach onto the deck is a step the character controller can take.
      const land = heightAt(def, d.shoreX - d.dx * 3, d.shoreZ - d.dz * 3);
      expect(d.deckY - land).toBeLessThan(0.45);
      for (const b of d.boats) {
        const wb = waterAt(def, b.x, b.z);
        expect(wb).not.toBeNull();
        expect(wb!.depth).toBeGreaterThan(0.8);
      }
    }
  });

  it('the water level is flat and the mud surface marks the lake bed', () => {
    for (const l of def.lakes) {
      const w = waterAt(def, l.x + l.r * 0.5, l.z);
      if (w) expect(surfaceAt(def, l.x + l.r * 0.5, l.z)).toBe('mud');
      // Somewhere in the open water the floor is a proper depth down.
      let deepest = 0;
      for (let a = 0; a < 360; a += 20) for (let rr = 0; rr < l.r * 0.6; rr += 5) deepest = Math.max(deepest, waterAt(def, l.x + Math.cos(a) * rr, l.z + Math.sin(a) * rr)?.depth ?? 0);
      expect(deepest).toBeGreaterThan(3);
    }
  });
});

describe('lakes elsewhere', () => {
  it('city legs have none', () => {
    const def = makeTerrainDef(LEGS.legs.find((l) => l.biome === 'city')!);
    expect(def.lakes).toHaveLength(0);
    expect(waterAt(def, 0, 100)).toBeNull();
  });
});
