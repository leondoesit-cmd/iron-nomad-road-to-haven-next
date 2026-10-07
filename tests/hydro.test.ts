import { describe, expect, it } from 'vitest';
import { legById } from '../src/data';
import { buttes, heightAt, makeTerrainDef, surfaceAt, waterAt } from '../src/world/terrain';
import { nearestRoad } from '../src/world/openWorld';
import { lakeQ } from '../src/world/lakes';
import { bridgeTag, courseAt, forestAt, lushAt, onCauseway, readBridgeTag, swampQ, woodsAt } from '../src/world/hydro';
import { ChunkSource } from '../src/world/chunkgen';
import { CHUNK } from '../src/world/terrain';
import { TREE_SPECIES } from '../src/world/flora';

const leg = legById('W');
const def = makeTerrainDef(leg);
const hy = def.hydro!;

describe('the water of the open world', () => {
  it('is planned from the spec, the same every time', () => {
    expect(hy).toBeDefined();
    expect(hy.ready).toBe(true);
    expect(hy.rivers.length).toBe(leg.open!.water!.rivers.length);
    expect(hy.springs.length).toBe(leg.open!.water!.springs.length);
    expect(hy.swamps.length).toBe(leg.open!.water!.swamps.length);
    const again = makeTerrainDef(leg).hydro!;
    hy.rivers.forEach((r, k) => {
      expect(again.rivers[k].n).toBe(r.n);
      expect(Array.from(again.rivers[k].level)).toEqual(Array.from(r.level));
      expect(Array.from(again.rivers[k].x)).toEqual(Array.from(r.x));
    });
    expect(again.falls.map((f) => [f.name, f.x, f.z])).toEqual(hy.falls.map((f) => [f.name, f.x, f.z]));
    expect(Array.from(again.lush!)).toEqual(Array.from(hy.lush!));
  });

  it('never runs uphill, and every course ends in the water it is meant for', () => {
    for (const r of hy.rivers) {
      for (let i = 1; i < r.n; i++) expect(r.level[i]).toBeLessThanOrEqual(r.level[i - 1] + 1e-4);
      const x = r.x[r.n - 1];
      const z = r.z[r.n - 1];
      if (r.into.kind === 'lake') {
        const l = def.lakes[r.into.ref];
        expect(lakeQ(l, x, z)).toBeLessThan(1);
        expect(r.level[r.n - 1]).toBeCloseTo(l.level, 3);
      } else if (r.into.kind === 'swamp') {
        expect(swampQ(hy.swamps[r.into.ref], x, z)).toBeLessThan(1);
        expect(r.level[r.n - 1]).toBeCloseTo(hy.swamps[r.into.ref].level, 3);
      }
    }
  });

  it('holds water all along every course, except under a causeway and on the island in a bend', () => {
    for (const r of hy.rivers) {
      let wet = 0;
      for (let i = 2; i < r.end; i++) {
        const x = r.x[i];
        const z = r.z[i];
        if (hy.crossings.some((q) => Math.hypot(q.x - x, q.z - z) < q.roadHalf + 6)) continue;
        // A slanting crossing's causeway runs further along the course: anywhere the paved road's edge is that close.
        const rd = nearestRoad(def.open!, x, z);
        if (rd.road && rd.road.kind !== 'track' && rd.edge < 4.5) continue;
        if (hy.loops.some((q) => q.island && Math.hypot(q.island.x - x, q.island.z - z) < q.island.r + 2.5)) continue;
        // The Half Island's crossing over the top of its leg: earth over culverts.
        if (onCauseway(hy, x, z)) continue;
        const w = waterAt(def, x, z);
        expect(w, `${r.key} sample ${i}`).not.toBeNull();
        expect(w!.depth).toBeGreaterThan(0.05);
        expect(w!.kind === 'river' || w!.kind === 'stream' || w!.kind === 'lake' || w!.kind === 'swamp' || w!.kind === 'spring').toBe(true);
        if (w!.kind === r.kind) {
          wet++;
          expect(w!.flow).toBeDefined();
          // The current runs down the course.
          expect(w!.flow![0] * r.dx[i] + w!.flow![1] * r.dz[i]).toBeGreaterThan(0);
        }
      }
      expect(wet).toBeGreaterThan(r.end * 0.6);
    }
  });

  it('cuts no mesas: none stands in a course', () => {
    for (const r of hy.rivers) for (let i = 0; i < r.n; i += 5) expect(buttes(def, r.x[i], r.z[i])).toBe(0);
  });

  it('carries the highway and a side road over the rivers on dry causeways with bridges', () => {
    const hw = hy.crossings.find((c) => c.road.id === 'highway');
    const side = hy.crossings.find((c) => c.road.id === 'dustwell-w');
    expect(hw).toBeDefined();
    expect(side).toBeDefined();
    for (const c of hy.crossings) {
      const fx = Math.sin(c.yaw);
      const fz = Math.cos(c.yaw);
      // Along the road over the whole span, and out to the edge of the carriageway, the road stays dry and level.
      for (let a = -c.span / 2; a <= c.span / 2; a += 2) {
        for (const o of [-c.roadHalf + 0.5, 0, c.roadHalf - 0.5]) {
          const x = c.x + fx * a + fz * o;
          const z = c.z + fz * a - fx * o;
          expect(waterAt(def, x, z)).toBeNull();
          expect(Math.abs(heightAt(def, x, z) - c.y)).toBeLessThan(0.6);
        }
      }
      // Water stands on either side of the causeway, below the road.
      const r = hy.rivers[c.river];
      const up = Math.max(0, c.i - 8);
      const down = Math.min(r.end - 1, c.i + 8);
      expect(waterAt(def, r.x[up], r.z[up])).not.toBeNull();
      expect(waterAt(def, r.x[down], r.z[down])).not.toBeNull();
      expect(c.level).toBeLessThan(c.y);
    }
    // The bridge prop's tag round-trips.
    const t = readBridgeTag(bridgeTag(25.3, 6.4, 7));
    expect(t.span).toBeCloseTo(25.5, 5);
    expect(t.drop).toBeCloseTo(6.4, 5);
    expect(t.half).toBe(7);
  });

  it('has waterfalls: tall ones off the mountains, and cascades inside the map', () => {
    const rim = hy.falls.filter((f) => f.rim);
    expect(rim.length).toBeGreaterThanOrEqual(3);
    for (const f of rim) expect(f.top - f.bottom).toBeGreaterThan(25);
    const inner = hy.falls.filter((f) => !f.rim && f.top - f.bottom >= 2);
    expect(inner.length).toBeGreaterThanOrEqual(3);
    expect(hy.falls.map((f) => f.name)).toEqual(expect.arrayContaining(['Veil Falls', 'Silver Falls', 'North Falls', 'the Seven Steps']));
    // The foot of a rim fall is reachable ground inside the map, with water in its pool.
    const o = def.open!;
    for (const f of rim) {
      const r = hy.rivers[f.river];
      const i = Math.min(r.n - 1, f.i1 + 6);
      expect(r.x[i]).toBeGreaterThan(o.x0);
      expect(r.x[i]).toBeLessThan(o.x1);
      expect(r.z[i]).toBeLessThan(o.z1);
      expect(waterAt(def, r.x[i], r.z[i])).not.toBeNull();
    }
  });

  it('fills the swamps with shallow water and sodden ground', () => {
    for (const s of hy.swamps) {
      let wet = 0;
      let dry = 0;
      let deep = 0;
      for (let a = 0; a < 360; a += 12) {
        for (let k = 0.05; k < 0.9; k += 0.1) {
          const x = s.x + Math.cos((a * Math.PI) / 180) * s.r * k;
          const z = s.z + Math.sin((a * Math.PI) / 180) * s.r * k;
          if (swampQ(s, x, z) > 0.9) continue;
          const w = waterAt(def, x, z);
          if (w && w.kind === 'swamp') {
            wet++;
            if (w.depth > 0.3) deep++;
            expect(w.depth).toBeLessThan(3);
          } else if (!w) dry++;
          expect(surfaceAt(def, x, z)).toBe('mud');
        }
      }
      expect(wet).toBeGreaterThan(20);
      expect(dry).toBeGreaterThan(10);
      expect(deep).toBeGreaterThan(5);
    }
  });

  it('keeps clear water in the spring pools', () => {
    for (const s of hy.springs) {
      const w = waterAt(def, s.x, s.z);
      expect(w?.kind).toBe('spring');
      expect(w!.depth).toBeGreaterThan(0.5);
      expect(waterAt(def, s.x + s.r + 3, s.z)?.kind).not.toBe('spring');
    }
  });

  it('keeps the places, the hubs and the roads out of the water', () => {
    for (const s of def.sites) {
      if (s.kind.startsWith('island') || s.kind === 'lakeDock') continue;
      expect(waterAt(def, s.x, s.z), s.kind).toBeNull();
      const c = courseAt(hy, s.x, s.z);
      if (c) expect(c.d, s.kind).toBeGreaterThan(c.half + s.radius * 0.8);
    }
    for (const road of def.open!.roads) {
      const p = road.pts;
      for (let k = 0; k < p.length; k += 6) {
        const x = p[k];
        const z = p[k + 1];
        if (hy.crossings.some((q) => Math.hypot(q.x - x, q.z - z) < q.span)) continue;
        const w = waterAt(def, x, z);
        if (road.kind === 'track') {
          // A dirt track fords running water, shallow enough for a moped.
          if (w && (w.kind === 'river' || w.kind === 'stream')) expect(w.depth, road.id).toBeLessThan(0.36);
        } else if (w) expect(w.kind, `${road.id} at ${Math.round(x)},${Math.round(z)}`).toBe('lake');
      }
    }
  });

  it('greens the land round the water and in the green country, and leaves the start and the city bare', () => {
    expect(lushAt(def, 0, 10)).toBe(0);
    const d = def.open!.districts[0];
    expect(lushAt(def, (d.x0 + d.x1) / 2, (d.z0 + d.z1) / 2)).toBe(0);
    for (const r of hy.rivers) {
      const i = Math.floor(r.end / 2);
      const off = r.half[i] + 10;
      expect(lushAt(def, r.x[i] - r.dz[i] * off, r.z[i] + r.dx[i] * off), r.key).toBeGreaterThan(0.45);
    }
    let lush = 0;
    let wood = 0;
    let n = 0;
    for (let x = -2200; x < 2200; x += 50) {
      for (let z = -1300; z < 4200; z += 50) {
        n++;
        if (lushAt(def, x, z) > 0.42) lush++;
        if (forestAt(def, x, z) > 0.3) wood++;
      }
    }
    // About a third of the country is green and a sixth wooded; the rest is the dust it always was.
    expect(lush / n).toBeGreaterThan(0.2);
    expect(lush / n).toBeLessThan(0.55);
    expect(wood / n).toBeGreaterThan(0.08);
    expect(woodsAt(def, hy.swamps[0].x, hy.swamps[0].z)).toBe('fen');
  });

  it('binds the ground where it is green: a meadow is soil, never loose sand', () => {
    let sandy = 0;
    let green = 0;
    for (let x = -2200; x < 2200; x += 37) {
      for (let z = -1300; z < 4200; z += 37) {
        const s = surfaceAt(def, x, z);
        if (lushAt(def, x, z) > 0.45) {
          green++;
          expect(s).not.toBe('sand');
        } else if (s === 'sand') sandy++;
      }
    }
    expect(green).toBeGreaterThan(1000);
    // The dust is still dust.
    expect(sandy).toBeGreaterThan(500);
  });
});

describe('the woods', () => {
  const src = new ChunkSource(leg);
  const chunkAt = (x: number, z: number) => src.get(Math.floor(x / CHUNK), Math.floor(z / CHUNK));

  it('grow in the green country and not at the start', () => {
    expect(chunkAt(-1700, 1300).trees.length).toBeGreaterThan(60);
    expect(chunkAt(0, 10).trees.length).toBe(0);
    const fen = chunkAt(hy.swamps[1].x, hy.swamps[1].z).trees;
    expect(fen.length).toBeGreaterThan(30);
    expect(fen.every((t) => TREE_SPECIES[t.sp] === 'cypress' || TREE_SPECIES[t.sp] === 'snag')).toBe(true);
    const oasis = hy.springs.find((s) => s.oasis)!;
    expect(chunkAt(oasis.x, oasis.z).trees.some((t) => TREE_SPECIES[t.sp] === 'palm')).toBe(true);
  });

  it('keep off the roads, out of the water and off the places, and every trunk is solid', () => {
    const o = def.open!;
    for (const [x, z] of [[-1700, 1300], [-1250, 3850], [hy.swamps[1].x, hy.swamps[1].z], [-1350, -300], [-760, 2080], [-1160, 260]]) {
      const c = chunkAt(x, z);
      for (const t of c.trees) {
        const rd = nearestRoad(o, t.x, t.z);
        if (rd.road) expect(rd.edge).toBeGreaterThan(3);
        const w = waterAt(def, t.x, t.z);
        if (w) {
          expect(TREE_SPECIES[t.sp] === 'cypress' || TREE_SPECIES[t.sp] === 'snag').toBe(true);
          expect(w.depth).toBeLessThan(0.5);
        }
        for (const s of def.sites) if (s.radius > 0) expect(Math.hypot(t.x - s.x, t.z - s.z)).toBeGreaterThan(s.radius * 0.95);
        expect(Math.abs(t.y - heightAt(def, t.x, t.z))).toBeLessThan(0.4);
      }
      const trunks = c.aabbs.filter((a) => a.kind === 'tree');
      expect(trunks.length).toBe(c.trees.length);
    }
  });

  it('are the same trees every time the chunk is made', () => {
    const other = new ChunkSource(leg);
    const a = chunkAt(-1700, 1300).trees;
    const b = other.get(Math.floor(-1700 / CHUNK), Math.floor(1300 / CHUNK)).trees;
    expect(b.map((t) => [t.x, t.z, t.sp, t.v])).toEqual(a.map((t) => [t.x, t.z, t.sp, t.v]));
  });
});

describe('corridor legs', () => {
  it('have no running water of their own', () => {
    const d = makeTerrainDef(legById('L1'));
    expect(d.hydro).toBeUndefined();
    expect(lushAt(d, 0, 100)).toBe(0);
  });
});
