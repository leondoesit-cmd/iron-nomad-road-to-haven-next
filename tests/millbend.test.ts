import { beforeAll, describe, expect, it } from 'vitest';
import { G, GROUPS, groups, initPhysics, PhysicsWorld, RAPIER } from '../src/physics/physics';
import { legById } from '../src/data';
import { ChunkSource } from '../src/world/chunkgen';
import { CHUNK, heightAt, surfaceAt, waterAt } from '../src/world/terrain';
import { courseAt, hydroMud, onCauseway } from '../src/world/hydro';
import { heritageAabbs, heritageRoofAt, hLocal, hWorld, OM } from '../src/world/heritage';
import * as THREE from 'three';
import { bendClear, bendGround, caneThicket, caneTunnelNear, onIsland } from '../src/world/millBend';
import { buildScatter } from '../src/render/scatter';
import { propCollisionMesh } from '../src/render/propCollision';
import { plantForage } from '../src/world/forage';
import { TREE_SPECIES } from '../src/world/flora';
import { faceStrength, gumFootGeometry } from '../src/render/faceGums';
import { DrugState, NO_LOOK } from '../src/sim/drugs';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { fakeServices, run } from './helpers/sim';

// The Half Island on the Yarkon, at Abu Rabah mill: the river round a raised meadow but for a narrow crossing, the mill across
// the river beside it and a little pond with an island on the other side, the dirt road round the outer bank behind the cane,
// the old gums with faces in their bark, the liberty caps round their roots, the muddy bank, the landing and the pedal boat.

beforeAll(async () => {
  await initPhysics();
});

const leg = legById('W');
const src = new ChunkSource(leg);
const L = src.layout;
const def = L.terrain;
const hy = def.hydro!;
const yarkon = hy.rivers.find((r) => r.key === 'yarkon')!;
const house = def.heritage!.find((h) => h.id === 'concreteHouse')!;
const mill = def.heritage!.find((h) => h.id === 'oldMill')!;
const bend = def.bends![0];
const lp = bend.loop;

/** River water (not just ground below the level) at a point. */
const wet = (x: number, z: number) => {
  const w = waterAt(def, x, z);
  return !!w && w.depth > 0.05;
};

/** Walking in at the neck: the unit way into the bulb, and the way to the left hand (y up: facing -z, +x is on the right). */
const inward = () => {
  const ux = lp.x - lp.nx;
  const uz = lp.z - lp.nz;
  const l = Math.hypot(ux, uz);
  return { ux: ux / l, uz: uz / l, lx: uz / l, lz: -ux / l };
};

/** How far a point stands past the edge of the footpath in (negative on it). */
const pathGap = (x: number, z: number) => {
  let d = Infinity;
  const p = bend.path;
  for (let k = 0; k + 1 < p.length; k++) {
    const [ax, az] = p[k];
    const ex = p[k + 1][0] - ax;
    const ez = p[k + 1][1] - az;
    const u = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    d = Math.min(d, Math.hypot(x - ax - ex * u, z - az - ez * u));
  }
  return d - 1.3;
};

describe('the Half Island', () => {
  it('is an omega bend of the Yarkon four or five minutes on foot from the Concrete House: water all round, one crossing by the mill', () => {
    expect(bend.name).toBe('the Half Island');
    expect(lp.river).toBe(yarkon.id);
    // A walk of 4 or 5 minutes at the game's walking pace (3.4 m/s): 700 to 1000 m.
    const d = Math.hypot(lp.nx - house.x, lp.nz - house.z);
    expect(d).toBeGreaterThan(700);
    expect(d).toBeLessThan(1000);
    // From the middle of the meadow, look out every way: water nearly all round, dry land out through the neck.
    let water = 0;
    for (let k = 0; k < 36; k++) {
      const a = (k / 36) * Math.PI * 2;
      let hit = false;
      for (let r = 5; r < lp.r + 40 && !hit; r += 1) hit = wet(lp.x + Math.cos(a) * r, lp.z + Math.sin(a) * r);
      if (hit) water++;
    }
    expect(water).toBeGreaterThanOrEqual(33);
    // The one dry way out: from the middle of the meadow over the crossing by the mill onto the outer bank; with the
    // crossing's causeway taken away, none (not out through the neck either).
    const { ux, uz } = inward();
    const G = 1;
    const x0 = lp.x - lp.r - 90;
    const z0 = lp.z - lp.r - 90;
    const W = Math.ceil((2 * lp.r + 180) / G);
    const cell = (x: number, z: number) => Math.floor((z - z0) / G) * W + Math.floor((x - x0) / G);
    const fill = (blocked: (x: number, z: number) => boolean) => {
      const seen = new Uint8Array(W * W);
      const queue = [cell(lp.x, lp.z)];
      seen[queue[0]] = 1;
      while (queue.length) {
        const c = queue.pop()!;
        const ci = c % W;
        const cj = Math.floor(c / W);
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= W || j >= W) continue;
          const k = j * W + i;
          const x = x0 + (i + 0.5) * G;
          const z = z0 + (j + 0.5) * G;
          if (seen[k] || wet(x, z) || blocked(x, z)) continue;
          seen[k] = 1;
          queue.push(k);
        }
      }
      return seen;
    };
    const c = lp.cross!;
    const open = fill(() => false);
    expect(open[cell(c.x0, c.z0)]).toBe(1);
    const shut = fill((x, z) => onCauseway(hy, x, z));
    expect(shut[cell(c.x0, c.z0)]).toBe(0);
    expect(shut[cell(lp.nx - ux * 30, lp.nz - uz * 30)]).toBe(0);
    // Across the neck's mouth the legs' waters run together.
    const { lx, lz } = inward();
    let dry = 0;
    for (let s = -12; s <= 12; s += 0.5) if (!wet(lp.nx + ux * 6 + lx * s, lp.nz + uz * 6 + lz * s)) dry++;
    expect(dry).toBe(0);
  });

  it('has a strip of land four metres wide between the leg and the pond, where the crossing comes onto the island', () => {
    // Across the strip at its narrowest: from the pond's edge to the other water.
    const { ux, uz, lx, lz } = inward();
    // Row by row beside the pond: every stretch of dry land with water either side of it, near the neck's line.
    let narrowest = Infinity;
    const is = lp.island!;
    const ti = (is.x - lp.nx) * ux + (is.z - lp.nz) * uz;
    for (let a = ti - 12; a < ti + 8; a += 0.5) {
      let start = NaN;
      let prevWet = false;
      for (let s = -25; s <= 25; s += 0.1) {
        const x = lp.nx + ux * a + lx * s;
        const z = lp.nz + uz * a + lz * s;
        const w = wet(x, z);
        if (!w && prevWet) start = s;
        if (w && !prevWet && !Number.isNaN(start) && s - start > 1) {
          // (Not the island itself.)
          const ms = (start + s) / 2;
          if (Math.hypot(lp.nx + ux * a + lx * ms - is.x, lp.nz + uz * a + lz * ms - is.z) > is.r + 1.5) narrowest = Math.min(narrowest, s - start);
        }
        prevWet = w;
      }
    }
    expect(narrowest).toBeGreaterThan(2.8);
    expect(narrowest).toBeLessThan(6);
  });

  it('rises to a low hill in the middle, the banks low by the water', () => {
    expect(heightAt(def, lp.x, lp.z) - lp.plain).toBeGreaterThan(2.8);
    expect(lp.plain).toBeGreaterThan(yarkon.level[lp.mill] + 0.5);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const r = bend.meadow - 4;
      const x = lp.x + Math.cos(a) * r;
      const z = lp.z + Math.sin(a) * r;
      if (wet(x, z)) continue;
      expect(Math.abs(heightAt(def, x, z) - lp.plain)).toBeLessThan(0.9);
    }
  });

  it('has a dirt road round its outer bank behind the cane, and a track from it out to a road', () => {
    const road = def.open!.roads.find((q) => q.id === `ring:${bend.key}`)!;
    expect(road).toBeDefined();
    expect(road.kind).toBe('track');
    // All the way round the outside, a few metres past the water's edge.
    let near = 0;
    const p = road.pts;
    for (let s = 0; s < p.length; s += 2) {
      const c = courseAt(hy, p[s], p[s + 1], 30);
      expect(Math.hypot(p[s] - lp.x, p[s + 1] - lp.z)).toBeGreaterThan(lp.r);
      if (c && c.d - c.half > 5 && c.d - c.half < 16) near++;
    }
    expect(near / (p.length / 2)).toBeGreaterThan(0.85);
    expect(p.length / 2).toBeGreaterThan(40);
    // The track out reaches another road.
    const out = def.open!.roads.find((q) => q.id === `ring:${bend.key}:out`)!;
    expect(out).toBeDefined();
    const ex = out.pts[out.pts.length - 2];
    const ez = out.pts[out.pts.length - 1];
    expect(def.open!.roads.some((q) => !q.id.startsWith('ring:') && q.pts.some((v, i) => i % 2 === 0 && Math.hypot(v - ex, q.pts[i + 1] - ez) < 12))).toBe(true);
    // No dry wash cuts across the ring to drain into the bend.
    for (const w of def.washes?.washes ?? []) for (let i = 0; i < w.n; i++) expect(Math.hypot(w.x[i] - lp.x, w.z[i] - lp.z), w.name).toBeGreaterThan(lp.r + 40);
  });

  it("has mud along the inner bank all round, where the old gums' roots run out over it", () => {
    let mud = 0;
    let n = 0;
    for (let i = lp.i0; i <= lp.i1; i += 4) {
      // A point just up the inner bank (toward the bulb's centre).
      let nx = -yarkon.dz[i];
      let nz = yarkon.dx[i];
      if (nx * (lp.x - yarkon.x[i]) + nz * (lp.z - yarkon.z[i]) < 0) {
        nx = -nx;
        nz = -nz;
      }
      const x = yarkon.x[i] + nx * (yarkon.half[i] + 1.5);
      const z = yarkon.z[i] + nz * (yarkon.half[i] + 1.5);
      if (Math.hypot(x - lp.x, z - lp.z) > lp.r) continue;
      n++;
      if (hydroMud(hy, x, z)) mud++;
    }
    expect(n).toBeGreaterThan(20);
    expect(mud / n).toBeGreaterThan(0.85);
  });

  it('has a little island in the stream with water all round it', () => {
    const is = lp.island!;
    expect(is).toBeTruthy();
    expect(wet(is.x, is.z)).toBe(false);
    expect(heightAt(def, is.x, is.z)).toBeGreaterThan(yarkon.level[lp.i0 + 10] + 0.2);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      expect(wet(is.x + Math.cos(a) * (is.r + 4.5), is.z + Math.sin(a) * (is.r + 4.5))).toBe(true);
    }
    // Two old gums stand on it, in a little pond: the stream opens out round it.
    expect(bend.gums.filter((g) => g.island).length).toBe(2);
    let ii = 0;
    for (let i = 0; i < yarkon.n; i++) if (Math.hypot(yarkon.x[i] - is.x, yarkon.z[i] - is.z) < Math.hypot(yarkon.x[ii] - is.x, yarkon.z[ii] - is.z)) ii = i;
    expect(yarkon.half[ii]).toBeGreaterThan(yarkon.half[ii + 40] + 5);
    // On the right walking in, a stone's throw from the neck.
    const { lx, lz } = inward();
    expect((is.x - lp.nx) * lx + (is.z - lp.nz) * lz).toBeLessThan(-3);
    expect(Math.hypot(is.x - lp.nx, is.z - lp.nz)).toBeLessThan(50);
  });

  it('has a muddy landing on the inner bank', () => {
    const Ld = lp.landing!;
    const x = Ld.x + Ld.nx * 3;
    const z = Ld.z + Ld.nz * 3;
    expect(hydroMud(hy, x, z)).toBe(true);
    expect(surfaceAt(def, x, z)).toBe('mud');
    expect(bendGround(def, x, z)!.mud).toBeGreaterThan(0.8);
    // It slopes gently into the water: a little way out it is shallow enough to step off a boat.
    const w = waterAt(def, Ld.x - Ld.nx * 2, Ld.z - Ld.nz * 2)!;
    expect(w.depth).toBeGreaterThan(0.1);
    expect(w.depth).toBeLessThan(0.6);
    expect(heightAt(def, x, z) - Ld.level).toBeLessThan(0.5);
    // The fire ring and the stumps are on it.
    expect(L.props.some((p) => p.kind === 'campfire' && Math.hypot(p.x - Ld.x, p.z - Ld.z) < 10)).toBe(true);
    expect(bend.stumps.length).toBeGreaterThanOrEqual(4);
  });
});

describe('Abu Rabah mill', () => {
  it('stands lengthwise in the river where it comes round square into the top of the left-hand leg, the water under it', () => {
    expect(mill.name).toBe('Abu Rabah mill');
    const c = courseAt(hy, mill.x, mill.z)!;
    expect(c.river).toBe(yarkon);
    expect(c.d).toBeLessThan(1);
    // Up the left-hand leg from the neck, at its top: well in from the neck, out to the left of it.
    const { ux, uz, lx, lz } = inward();
    expect(lp.mill).toBeGreaterThan(lp.i0);
    expect(lp.mill).toBeLessThan(lp.i1);
    const t = (mill.x - lp.nx) * ux + (mill.z - lp.nz) * uz;
    expect(t).toBeGreaterThan(28);
    expect(t).toBeLessThan(60);
    expect((mill.x - lp.nx) * lx + (mill.z - lp.nz) * lz).toBeGreaterThan(18);
    // The run it stands in goes straight, square to an axis; its long side lies along it, its door side toward the outer bank.
    for (let i = lp.mill - 2; i <= lp.mill + 2; i++) expect(Math.min(Math.abs(yarkon.dx[i]), Math.abs(yarkon.dz[i]))).toBeLessThan(0.2);
    const [dx, dz] = [yarkon.dx[lp.mill], yarkon.dz[lp.mill]];
    const [ax, az] = hWorld(mill, 0, 1);
    expect(Math.abs((ax - mill.x) * dx + (az - mill.z) * dz)).toBeGreaterThan(0.95);
    const [ox, oz] = hWorld(mill, 1, 0);
    expect((ox - mill.x) * (mill.x - lp.x) + (oz - mill.z) * (mill.z - lp.z)).toBeGreaterThan(0);
    // In the water: under the middle of its floor and along both its long sides.
    expect(wet(mill.x, mill.z)).toBe(true);
    for (const s of [-1, 1]) expect(wet(...hWorld(mill, s * (OM.hw + 0.7), 3))).toBe(true);
    expect(mill.floor).toBeCloseTo(c.level, 1);
    // Its door's steps come down onto the crossing.
    expect(pathGap(...hWorld(mill, OM.hw + OM.steps.run, OM.door.z))).toBeLessThan(0.3);
    // Drawn, searchable.
    expect(L.props.some((p) => p.kind === 'oldMill')).toBe(true);
    expect(L.zones.find((z) => z.id.includes('oldMill'))!.containers.length).toBe(2);
  });

  it('is walked into from the crossing, up its steps and in at its door', () => {
    const w = new PhysicsWorld();
    const F = mill.floor;
    // The crossing beside it (as level as the meadow), and the bed under the water.
    const [gx, gz] = hWorld(mill, OM.hw + OM.steps.run + 3, 0);
    w.addStaticBox(gx, lp.plain - 1, gz, 6, 1, 6, 0, GROUPS.static);
    w.addStaticBox(mill.x, F - 3.5, mill.z, 20, 0.5, 20, 0, GROUPS.static);
    let id = 0;
    for (const a of heritageAabbs(mill, () => id++)) {
      if (a.ramp) w.addStaticTilted(a.ramp.x, a.ramp.y, a.ramp.z, a.ramp.hx, a.ramp.hy, a.ramp.hz, a.ramp.q, GROUPS.furn);
      else w.addStaticBox((a.minX + a.maxX) / 2, (a.y0 + a.y1) / 2, (a.minZ + a.maxZ) / 2, (a.maxX - a.minX) / 2, (a.y1 - a.y0) / 2, (a.maxZ - a.minZ) / 2, 0, a.kind === 'furniture' || a.kind === 'floor' ? GROUPS.furn : GROUPS.static);
    }
    const walker = new Walker(w);
    const go = (lx: number, lz: number) => {
      const [tx, tz] = hWorld(mill, lx, lz);
      for (let i = 0; i < 60 * 14 && Math.hypot(walker.x - tx, walker.z - tz) > 0.15; i++) walker.step(tx, tz);
      return Math.hypot(walker.x - tx, walker.z - tz);
    };
    // From the crossing, up the steps, in at the door, along the mill floor over the water to each end.
    walker.put(...hWorld(mill, OM.hw + OM.steps.run + 2, OM.door.z), lp.plain);
    expect(go(OM.hw - 1.4, OM.door.z)).toBeLessThan(0.3);
    expect(walker.y - F).toBeCloseTo(OM.deck, 1);
    expect(heritageRoofAt(def.heritage, walker.x, walker.z, walker.y + 0.9)).toBe(true);
    expect(go(-1.6, OM.door.z)).toBeLessThan(0.3);
    expect(go(-1.6, OM.hd - 1.4)).toBeLessThan(0.3);
    expect(go(-1.6, -OM.hd + 1.4)).toBeLessThan(0.3);
    // The walls are solid where there is no door.
    expect(go(-OM.hw - 3, -OM.hd + 1.4)).toBeGreaterThan(2);
    expect(hLocal(mill, walker.x, walker.z)[0]).toBeGreaterThan(-OM.hw);
  });
});

describe('the way in', () => {
  it('crosses onto the island beside the mill: along its door side, over the water on a causeway, the pond on the right', () => {
    const c = lp.cross!;
    expect(c).toBeTruthy();
    // It starts on the outer bank and ends on the island; all of it dry.
    expect(onIsland(def, c.x0, c.z0)).toBe(false);
    expect(onIsland(def, c.x1, c.z1)).toBe(true);
    for (const [x, z] of bend.path) expect(wet(x, z)).toBe(false);
    // Walking it, the mill is on the left.
    const lx = c.az;
    const lz = -c.ax;
    expect((mill.x - c.x0) * lx + (mill.z - c.z0) * lz).toBeGreaterThan(4);
    // Over the water it is the causeway: earth at the meadow's height, the river either side of it (it runs through under).
    const m = (c.s0 + c.s1) / 2;
    const [mx, mz] = [c.x0 + c.ax * m, c.z0 + c.az * m];
    expect(Math.abs(heightAt(def, mx, mz) - c.top)).toBeLessThan(0.15);
    for (const g of [1, -1]) expect(wet(mx + lx * g * (c.w / 2 + 2), mz + lz * g * (c.w / 2 + 2))).toBe(true);
    expect(c.s1 - c.s0).toBeGreaterThan(8);
    expect(L.props.filter((p) => p.kind === 'culvert').length).toBe(2);
    // The crossing is about 4 or 5 m wide, and off its far end, on in along the strip, the pond opens on the right.
    expect(c.w).toBeGreaterThanOrEqual(4);
    expect(c.w).toBeLessThanOrEqual(5.5);
    const is = lp.island!;
    expect(Math.hypot(is.x - c.x1, is.z - c.z1)).toBeLessThan(30);
    let k = 0;
    for (let q = 0; q < bend.path.length; q++) if (Math.hypot(bend.path[q][0] - is.x, bend.path[q][1] - is.z) < Math.hypot(bend.path[k][0] - is.x, bend.path[k][1] - is.z)) k = q;
    const [px, pz] = bend.path[k];
    const [qx, qz] = bend.path[Math.min(bend.path.length - 1, k + 1)];
    expect((is.x - px) * -(qz - pz) + (is.z - pz) * (qx - px)).toBeGreaterThan(0);
    // No path goes near the neck (its mouth is water).
    for (const [x, z] of bend.path) expect(Math.hypot(x - lp.nx, z - lp.nz)).toBeGreaterThan(20);
  });

  it('comes through a thicket of giant cane by a tangle of tunnels; no cane grows on the island', () => {
    const { ux, uz } = inward();
    // Outside the neck it is all cane; on the strip, the meadow and the little island, none.
    const p0 = bend.path[0];
    expect(caneThicket(def, p0[0], p0[1])).toBeGreaterThan(0.9);
    expect(onIsland(def, p0[0], p0[1])).toBe(false);
    const strip = bend.path[bend.path.length - 10];
    void ux;
    void uz;
    for (const [x, z] of [strip, [lp.x, lp.z], [lp.island!.x, lp.island!.z]] as [number, number][]) {
      expect(onIsland(def, x, z)).toBe(true);
      expect(caneThicket(def, x, z)).toBe(0);
    }
    // A tangle: the way on out from the path, ways off it and off those, some reaching the edge of the cane, all dry.
    expect(bend.tunnels.length).toBeGreaterThanOrEqual(6);
    let out = 0;
    for (const p of bend.tunnels) {
      expect(p.length / 2).toBeGreaterThanOrEqual(3);
      for (let k = 0; k < p.length; k += 2) expect(wet(p[k], p[k + 1])).toBe(false);
      if (Math.hypot(p[p.length - 2] - bend.hub[0], p[p.length - 1] - bend.hub[1]) > 35) out++;
    }
    expect(out).toBeGreaterThanOrEqual(2);
    // The tunnels' floors are bare earth, and the cane stands thick either side of them and none in them.
    const t0 = bend.tunnels[0];
    const [tx, tz] = [t0[10], t0[11]];
    expect(bendGround(def, tx, tz)!.path).toBeGreaterThan(0.9);
    const c = src.get(Math.floor(tx / CHUNK), Math.floor(tz / CHUNK));
    const set = buildScatter(def, c.cx, c.cz, c.aabbs, c.props, 1, undefined, c.heights);
    const cane = set.cane!;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    let inTunnel = 0;
    let beside = 0;
    let onIsle = 0;
    for (let i = 0; i < cane.count; i++) {
      cane.getMatrixAt(i, m);
      pos.setFromMatrixPosition(m);
      const tn = caneTunnelNear(def, pos.x, pos.z, 3);
      if (tn && tn.d < tn.half) inTunnel++;
      if (tn && tn.d < tn.half + 2.5) beside++;
      if (onIsland(def, pos.x, pos.z)) onIsle++;
    }
    expect(cane.count).toBeGreaterThan(500);
    expect(inTunnel).toBe(0);
    expect(beside).toBeGreaterThan(40);
    expect(onIsle).toBe(0);
  });

  it('has a second row of old gums along the dirt road round the far side', () => {
    expect(bend.row.length).toBeGreaterThanOrEqual(12);
    const ring = def.open!.roads.find((q) => q.id === `ring:${bend.key}`)!.pts;
    const { ux, uz } = inward();
    const far = Math.hypot(lp.x - lp.nx, lp.z - lp.nz) * 0.8;
    for (const g of bend.row) {
      expect(g.sp).toBe(TREE_SPECIES.indexOf('eucalyptus'));
      expect(g.s).toBeGreaterThan(1.25);
      expect((g.x - lp.nx) * ux + (g.z - lp.nz) * uz).toBeGreaterThan(far - 20);
      // Just off the road, on the far side of it from the bend.
      let d = Infinity;
      for (let k = 0; k < ring.length; k += 2) d = Math.min(d, Math.hypot(ring[k] - g.x, ring[k + 1] - g.z));
      expect(d).toBeGreaterThan(4);
      expect(d).toBeLessThan(9);
      expect(Math.hypot(g.x - lp.x, g.z - lp.z)).toBeGreaterThan(lp.r + 10);
      expect(wet(g.x, g.z)).toBe(false);
    }
    // Planted with the chunks' trees.
    const g = bend.row[0];
    expect(src.get(Math.floor(g.x / CHUNK), Math.floor(g.z / CHUNK)).trees.some((t) => Math.hypot(t.x - g.x, t.z - g.z) < 0.01)).toBe(true);
  });
});

describe('the old gums', () => {
  it('stand wide apart on the meadow, seven of them, each with a face or two in its foot', () => {
    const meadow = bend.gums.filter((g) => !g.island);
    expect(meadow.length).toBe(7);
    for (const g of meadow) {
      expect(Math.hypot(g.x - lp.x, g.z - lp.z)).toBeLessThan(bend.meadow);
      expect(wet(g.x, g.z)).toBe(false);
      expect(Math.hypot(g.x - mill.x, g.z - mill.z)).toBeGreaterThan(20);
      for (const o of meadow) if (o !== g) expect(Math.hypot(g.x - o.x, g.z - o.z)).toBeGreaterThan(16);
      expect(g.faces.length).toBeGreaterThanOrEqual(1);
      expect(g.r).toBeGreaterThan(1.1);
    }
    expect(new Set(meadow.map((g) => g.form)).size).toBe(3);
    // A forked one grows the eucalyptus's V out of its foot; the others the broad old red gum.
    expect(meadow.filter((g) => g.form === 'fork').every((g) => g.stems[0].v === 2)).toBe(true);
    expect(meadow.filter((g) => g.form !== 'fork').every((g) => g.stems[0].v === 0)).toBe(true);
  });

  it('grow their stems as eucalyptus in the chunks, and nothing else grows on the meadow', () => {
    const sp = TREE_SPECIES.indexOf('eucalyptus');
    const seen = new Set<string>();
    let other = 0;
    const cx0 = Math.floor((lp.x - lp.r) / CHUNK);
    const cx1 = Math.floor((lp.x + lp.r) / CHUNK);
    const cz0 = Math.floor((lp.z - lp.r) / CHUNK);
    const cz1 = Math.floor((lp.z + lp.r) / CHUNK);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        for (const t of src.get(cx, cz).trees) {
          const g = bend.gums.find((q) => Math.hypot(q.x - t.x, q.z - t.z) < q.r);
          if (g) {
            expect(t.sp).toBe(sp);
            seen.add(`${g.id}:${t.x.toFixed(2)}`);
          } else if (bendClear(def, t.x, t.z)) other++;
        }
      }
    }
    expect(seen.size).toBe(bend.gums.reduce((n, g) => n + g.stems.length, 0));
    expect(other).toBe(0);
    // Their feet collide.
    for (const g of bend.gums) expect(L.aabbs.some((a) => a.kind === 'tree' && Math.abs((a.minX + a.maxX) / 2 - g.x) < 0.1 && Math.abs((a.minZ + a.maxZ) / 2 - g.z) < 0.1)).toBe(true);
  });

  it('have faces that are only hinted sober and come forward on a trip', () => {
    const g = bend.gums[0];
    const geo = gumFootGeometry(g, true);
    const face = geo.getAttribute('aFace');
    let trip = 0;
    let dark = 0;
    let glow = 0;
    for (let i = 0; i < face.count; i++) {
      trip = Math.max(trip, Math.abs(face.getX(i)));
      dark = Math.max(dark, face.getY(i));
      glow = Math.max(glow, face.getW(i));
    }
    expect(trip).toBeGreaterThan(0.05);
    expect(dark).toBeGreaterThan(0.6);
    expect(glow).toBeGreaterThan(0.8);
    // The plain mesh, far off, is a fraction of it.
    expect(gumFootGeometry(g, false).getIndex()!.count).toBeLessThan(geo.getIndex()!.count / 4);
    // Sober, nothing; at the peak of the mushrooms, all the way.
    expect(faceStrength(NO_LOOK)).toBe(0);
    const d = new DrugState(() => 0.5);
    d.dose('mushrooms');
    for (let i = 0; i < 60 * 70; i++) d.update(1 / 60);
    expect(faceStrength(d.look())).toBeGreaterThan(0.9);
  });

  it('have liberty caps round their roots, up every day', () => {
    const found: string[] = [];
    for (const s of bend.shrooms) {
      const cx = Math.floor(s.x / CHUNK);
      const cz = Math.floor(s.z / CHUNK);
      const data = src.get(cx, cz);
      const spots = plantForage(def, cx, cz, { heights: data.heights, aabbs: data.aabbs, props: data.props, trees: data.trees });
      const hit = spots.find((q) => Math.abs(q.x - s.x) < 0.01 && Math.abs(q.z - s.z) < 0.01);
      expect(hit).toBeDefined();
      expect(hit!.shroom).toBe('liberty');
      expect(hit!.always).toBe(true);
      found.push(hit!.id);
    }
    expect(new Set(found).size).toBe(bend.shrooms.length);
    expect(bend.shrooms.length).toBeGreaterThanOrEqual(14);
  });
});

describe('at the Half Island in play', () => {
  it('names the bend and the mill, and keeps the pedal boat tied up until someone pedals it away', () => {
    const memory = new WorldMemory();
    const h = fakeServices();
    const Ld = lp.landing!;
    const sc = new LegScene(h.svc, leg, { memory, start: { x: Ld.x + Ld.nx * 14, z: Ld.z + Ld.nz * 14, yaw: 0 } });
    (sc as unknown as { updateTether: () => void }).updateTether = () => {};
    const boat = sc.vehicles.find((v) => v.def.id === 'pedalo')!;
    expect(boat).toBeDefined();
    expect(boat.pedal).toBe(true);
    const at = { x: boat.position.x, z: boat.position.z };
    run(sc, 40);
    // Named on the radio and the banner, once each.
    expect(h.banners.filter((b) => b.startsWith('The Half Island |')).length).toBe(1);
    expect(h.radio.some((r) => r.includes('pedal boat'))).toBe(true);
    expect(h.banners.filter((b) => b.startsWith('Abu Rabah mill |')).length).toBe(1);
    const f = sc.mapFrame(sc.compassPins())!;
    expect(f.pins.some((q) => q.kind === 'heritage' && q.label === 'ABU RABAH MILL')).toBe(true);
    expect(f.pins.some((q) => q.label === 'HALF ISLAND')).toBe(true);
    // Tied up: the current has not taken it.
    expect(Math.hypot(boat.position.x - at.x, boat.position.z - at.z)).toBeLessThan(1.5);
    expect((boat.body as unknown as { submerged: number }).submerged).toBeGreaterThan(0.2);
    // Two aboard, side by side, pedalling: slow and steady out over the water, no fuel burnt.
    const [p0, p1] = sc.players;
    for (const p of sc.players) if (p.vehicle) p.exitVehicle(false);
    const pr = p0 as unknown as { enterTo: unknown; enterSeat: string; finishEnter(): void };
    pr.enterTo = boat;
    pr.enterSeat = 'driver';
    pr.finishEnter();
    const pr1 = p1 as unknown as { enterTo: unknown; enterSeat: string; finishEnter(): void };
    pr1.enterTo = boat;
    pr1.enterSeat = 'gunner';
    pr1.finishEnter();
    expect(boat.engineOn).toBe(true);
    const fuel = boat.fuel;
    p0.drive = () => ({ steer: 0, throttle: 1, brake: 0, handbrake: false });
    // Out across the stream (it fetches up on the far bank in a few seconds).
    let top = 0;
    run(sc, 8, () => (top = Math.max(top, Math.abs(boat.speed) * 3.6)));
    expect(top).toBeGreaterThan(4);
    expect(top).toBeLessThan(10);
    expect(Math.hypot(boat.position.x - at.x, boat.position.z - at.z)).toBeGreaterThan(8);
    expect(boat.fuel).toBe(fuel);
    sc.dispose();
  }, 180000);
});

const RAY_STATIC = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD | G.FURN);
const BODY_H = 1.7;
const BODY_R = 0.3;

/** A player capsule driven the way the game drives it (as in tests/walk.test.ts). */
class Walker {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  kcc: RAPIER.KinematicCharacterController;
  vy = 0;
  constructor(private world: PhysicsWorld) {
    this.body = world.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
    this.collider = world.world.createCollider(RAPIER.ColliderDesc.capsule((BODY_H - BODY_R * 2) / 2, BODY_R).setCollisionGroups(GROUPS.player), this.body);
    this.kcc = world.world.createCharacterController(0.03);
    this.kcc.enableAutostep(0.45, 0.2, false);
    this.kcc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.kcc.enableSnapToGround(0.35);
    this.kcc.setApplyImpulsesToDynamicBodies(false);
  }
  put(x: number, z: number, y: number) {
    this.body.setTranslation({ x, y: y + BODY_H / 2 + 0.02, z }, true);
    this.vy = 0;
    this.world.step();
  }
  get x() {
    return this.body.translation().x;
  }
  get y() {
    return this.body.translation().y - BODY_H / 2;
  }
  get z() {
    return this.body.translation().z;
  }
  step(tx: number, tz: number, speed = 3.2) {
    const dt = 1 / 60;
    const dx = tx - this.x;
    const dz = tz - this.z;
    const d = Math.hypot(dx, dz) || 1;
    const k = Math.min(1, d / (speed * dt));
    this.vy = Math.max(-30, this.vy - 22 * dt);
    this.kcc.computeColliderMovement(this.collider, { x: (dx / d) * speed * dt * k, y: this.vy * dt, z: (dz / d) * speed * dt * k }, undefined, RAY_STATIC);
    const m = this.kcc.computedMovement();
    if (this.kcc.computedGrounded() && this.vy < 0) this.vy = 0;
    const t = this.body.translation();
    const n = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    this.body.setNextKinematicTranslation(n);
    this.body.setTranslation(n, false);
    this.world.step();
  }
}
