import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { LEGS, legById } from '../src/data';
import { buildLayout } from '../src/world/layout';
import { generateDelve, floorAt } from '../src/world/delve';
import { roadX, corridorHalf, waterAt } from '../src/world/terrain';
import { Btn } from '../src/input/intents';
import { ACTIONS, ACTION_BY_ID, defaultBindings } from '../src/input/bindings';
import { LegScene } from '../src/game/legScene';
import { DelveScene, carryOf } from '../src/game/delveScene';
import type { DelveSite } from '../src/world/delveSites';
import { LegMapBaker, MapProjection, delveBounds, fitRect, headingFor, known, minefieldOutline, newDelveBase, radiusFor, newFrame, revealDelve, roadLine } from '../src/ui/mapdata';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

const alpha = (b: { data: Uint8ClampedArray; w: number; x0: number; z0: number; cell: number }, x: number, z: number) =>
  b.data[(Math.floor((z - b.z0) / b.cell) * b.w + Math.floor((x - b.x0) / b.cell)) * 4 + 3];
const rgb = (b: { data: Uint8ClampedArray; w: number; x0: number; z0: number; cell: number }, x: number, z: number) => {
  const o = (Math.floor((z - b.z0) / b.cell) * b.w + Math.floor((x - b.x0) / b.cell)) * 4;
  return [b.data[o], b.data[o + 1], b.data[o + 2]];
};

describe('map projection', () => {
  it('puts north at the top and +X on the left when the map is north up', () => {
    const P = new MapProjection().set(100, 200, 0, 2, 50, 50);
    expect(P.x(100, 200)).toBeCloseTo(50);
    expect(P.y(100, 200)).toBeCloseTo(50);
    expect(P.y(100, 210)).toBeCloseTo(30); // 10 m north, 2 px per metre, up the screen
    expect(P.x(110, 200)).toBeCloseTo(30); // 10 m toward +X, to the left
  });

  it('turns so the heading points up the screen', () => {
    // Facing +X (yaw 90 degrees): a point ahead along +X is above the centre, and north is then to the right.
    const P = new MapProjection().set(0, 0, Math.PI / 2, 1, 0, 0);
    expect(P.y(10, 0)).toBeCloseTo(-10);
    expect(P.x(0, 10)).toBeCloseTo(10);
  });

  it('the canvas matrix agrees with the point projection', () => {
    const P = new MapProjection().set(12, 340, 0.7, 1.3, 80, 60);
    const [a, b, c, d, e, f] = P.matrix(-50, 20, 8);
    for (const [i, j] of [[0, 0], [3, 5], [10, 2]]) {
      const wx = -50 + i * 8;
      const wz = 20 + j * 8;
      expect(a * i + c * j + e).toBeCloseTo(P.x(wx, wz), 6);
      expect(b * i + d * j + f).toBeCloseTo(P.y(wx, wz), 6);
    }
  });

  it('draws a long leg north up in a tall panel and turns it to run along a wide one', () => {
    const r = { x0: -500, x1: 500, z0: 0, z1: 3600 };
    expect(headingFor(r, 600, 700)).toBe(0);
    expect(headingFor(r, 1200, 340)).toBeCloseTo(Math.PI / 2);
    // A squat area stays north up whatever the panel.
    expect(headingFor({ x0: -100, x1: 100, z0: 0, z1: 120 }, 1200, 340)).toBe(0);
    const tall = fitRect(r, 0, 600, 700, 5);
    expect(tall.scale).toBeCloseTo(690 / 3600, 5);
    const wide = fitRect(r, Math.PI / 2, 1200, 340, 5);
    expect(wide.scale).toBeCloseTo(330 / 1000, 5); // turned, the leg runs along the width: the short side is what limits it
    expect(wide.cx).toBe(0);
    expect(wide.cz).toBe(1800);
  });

  it('widens the minimap with speed, within its limits', () => {
    const f = newFrame('leg');
    f.radiusMin = 100;
    f.radiusMax = 300;
    expect(radiusFor(f, 0)).toBe(100);
    expect(radiusFor(f, 14)).toBeCloseTo(200);
    expect(radiusFor(f, 90)).toBe(300);
  });
});

describe.each(LEGS.legs.map((l) => [l.id, l] as const))('the baked ground of %s', (_id, leg) => {
  const layout = buildLayout(leg);
  const baker = new LegMapBaker(layout.terrain, layout);

  it('bakes in slices and then reports done', () => {
    let steps = 0;
    while (!baker.step(0.5) && steps < 100000) steps++;
    if (leg.biome === 'wasteland') expect(steps).toBeGreaterThan(0);
    expect(baker.base.done).toBe(true);
    expect(baker.progress).toBe(1);
  });

  it('covers the road from start to camp', () => {
    const b = baker.base;
    for (let z = 20; z < leg.length; z += 130) expect(alpha(b, roadX(layout.terrain, z), z)).toBe(255);
    expect(baker.bounds.z0).toBeLessThan(0);
    expect(baker.bounds.z1).toBeGreaterThan(leg.length);
  });

  it('is deterministic', () => {
    const again = new LegMapBaker(layout.terrain, layout).finish();
    expect(again.data.length).toBe(baker.base.data.length);
    expect(Buffer.from(again.data).equals(Buffer.from(baker.base.data))).toBe(true);
  });

  if (leg.biome === 'wasteland') {
    it.skipIf(!!leg.open)('leaves the cliffs beyond the corridor blank', () => {
      const z = 1000;
      const out = roadX(layout.terrain, z) + corridorHalf(layout.terrain, z) + 60;
      expect(out).toBeLessThan(baker.bounds.x1 + 1);
      if (out < baker.bounds.x1) expect(alpha(baker.base, out, z)).toBe(0);
    });

    it('draws each lake as water', () => {
      for (const l of layout.terrain.lakes) {
        // Somewhere on the water: a ring inside the shore, since the middle may be an island.
        let hit: [number, number] | null = null;
        for (let a = 0; a < 6.28 && !hit; a += 0.3) {
          for (const k of [0.3, 0.5, 0.7]) {
            const x = l.x + Math.cos(a) * l.r * k;
            const z = l.z + Math.sin(a) * l.r * k;
            // Open water all round the spot, so a coarse map cell cannot straddle the shore.
            const wet = (dx: number, dz: number) => waterAt(layout.terrain, x + dx, z + dz);
            if (wet(0, 0) && wet(9, 0) && wet(-9, 0) && wet(0, 9) && wet(0, -9)) {
              hit = [x, z];
              break;
            }
          }
        }
        expect(hit).not.toBeNull();
        const [r, , b] = rgb(baker.base, hit![0], hit![1]);
        expect(b).toBeGreaterThanOrEqual(r - 40); // teal or brine or ash: never the warm tones of the ground
        expect(alpha(baker.base, hit![0], hit![1])).toBe(255);
      }
    });

    it('marks every building', () => {
      for (const r of layout.rural.slice(0, 5)) {
        const [cr, cg, cb] = rgb(baker.base, (r.aabb.minX + r.aabb.maxX) / 2, (r.aabb.minZ + r.aabb.maxZ) / 2);
        expect([cr, cg, cb]).toEqual([62, 50, 40]);
      }
    });
  } else {
    it('draws the blocks lighter than the streets', () => {
      const lot = layout.lots.find((l) => l.kind === 'building' && l.z0 > 100 && l.z1 < leg.length)!;
      const inLot = rgb(baker.base, (lot.x0 + lot.x1) / 2, (lot.z0 + lot.z1) / 2);
      const street = rgb(baker.base, 0, 100);
      expect(inLot[0]).toBeGreaterThan(street[0]);
    });
  }
});

describe('map shapes', () => {
  it('a minefield outline closes around the road it follows', () => {
    const def = buildLayout(legById('L1')).terrain;
    const m = def.minefields[0];
    const poly = minefieldOutline(def, m.z0, m.z1, m.halfWidth);
    expect(poly.length % 2).toBe(0);
    const xs = poly.filter((_, i) => i % 2 === 0);
    const zs = poly.filter((_, i) => i % 2 === 1);
    expect(Math.min(...zs)).toBe(m.z0);
    expect(Math.max(...zs)).toBe(m.z1);
    // The first leg of the outline is half a width right of the road, the last is half a width left of it.
    expect(xs[0] - roadX(def, m.z0)).toBeCloseTo(m.halfWidth);
    expect(xs[xs.length - 1] - roadX(def, m.z0)).toBeCloseTo(-m.halfWidth);
  });

  it('the road line runs from before the start to past the camp', () => {
    const def = buildLayout(legById('L1')).terrain;
    const line = roadLine(def);
    expect(line[1]).toBeLessThan(0);
    expect(line[line.length - 1]).toBeGreaterThan(def.length);
  });
});

describe('a delve map', () => {
  const m = generateDelve('mine', 777, 2);

  it('shows nothing until the party has been near, then the floor and the rock face around them', () => {
    const base = newDelveBase(m);
    expect(known(base, m.start.x, m.start.z)).toBe(false);
    expect(revealDelve(base, m, m.start.x, m.start.z, 9)).toBe(true);
    expect(known(base, m.start.x, m.start.z)).toBe(true);
    expect(base.version).toBeGreaterThan(0);
    // Somewhere across the cave stays dark.
    const far = m.chests.map((c) => ({ c, d: Math.hypot(c.x - m.start.x, c.z - m.start.z) })).sort((a, b) => b.d - a.d)[0];
    expect(known(base, far.c.x, far.c.z)).toBe(false);
    // A second look from the same place has nothing new to show.
    expect(revealDelve(base, m, m.start.x, m.start.z, 9)).toBe(false);
  });

  it('only paints solid rock where it borders the floor', () => {
    const base = newDelveBase(m);
    revealDelve(base, m, m.start.x, m.start.z, 30);
    for (let j = 0; j < m.h; j++) {
      for (let i = 0; i < m.w; i++) {
        if (base.data[(j * base.w + i) * 4 + 3] === 0 || m.grid[j * m.w + i] === 1) continue;
        let next = false;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (m.grid[Math.min(m.h - 1, Math.max(0, j + dj)) * m.w + Math.min(m.w - 1, Math.max(0, i + di))] === 1) next = true;
        expect(next).toBe(true);
      }
    }
    expect(floorAt(m, m.start.x, m.start.z)).toBe(true);
    const b = delveBounds(m);
    expect(b.x1 - b.x0).toBeGreaterThan(40);
  });
});

describe('the map button', () => {
  it('is bound to the D-pad right on a pad and to its own key on each keyboard layout', () => {
    const b = defaultBindings();
    expect(b.pad.map).toBe(Btn.Right);
    expect(ACTION_BY_ID.map.pad).toBe(Btn.Map);
    expect(b.kb[0].map).toBeTruthy();
    expect(b.kb[1].map).toBeTruthy();
    expect(b.kb[0].map).not.toBe(b.kb[1].map);
  });

  it('shares no key with any other action on either layout, and no pad button with another action', () => {
    const b = defaultBindings();
    const all = [...Object.values(b.kb[0]), ...Object.values(b.kb[1])];
    expect(new Set(all).size).toBe(all.length);
    const pads = ACTIONS.filter((a) => a.devices.includes('pad') && a.id !== 'view' && a.id !== 'jump').map((a) => b.pad[a.id]); // jump deliberately rides on interact
    expect(new Set(pads).size).toBe(pads.length);
  });
});

describe('maps in a running scene', () => {
  it('a leg tells the HUD where everyone is, bakes its ground, and keeps a place once it has been seen', () => {
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('L1'));
    // On foot, so moving a player moves the one the map follows.
    for (const p of sc.players) p.exitVehicle(false);
    run(sc, 0.3);
    expect(sc.mapModes).toBe(3);
    const f0 = sc.mapFrame(sc.compassPins())!;
    expect(f0.mode).toBe('leg');
    expect(f0.overview).toBe(true);
    expect(f0.movers.map((m) => m.seat)).toEqual([0, 1]);
    expect(f0.pins.some((p) => p.kind === 'end')).toBe(true);
    expect(f0.hazards.length).toBe(sc.terrain!.minefields.length);
    for (let i = 0; i < 400 && !f0.base!.done; i++) sc.mapFrame(sc.compassPins());
    expect(f0.base!.done).toBe(true);
    // Drive the first player to a roadside place and it appears; drive on and it stays.
    const site = sc.terrain!.sites.find((s) => s.z > 1200 && (s.kind === 'gasStop' || s.kind === 'hamlet' || s.kind === 'motel' || s.kind === 'farm' || s.kind === 'depot'))!;
    expect(site).toBeDefined();
    expect(f0.pins.some((p) => p.kind === 'site' && Math.abs(p.z - site.z) < 1)).toBe(false);
    sc.players[0].placeAt(site.x, site.z - 60, 0);
    const f1 = sc.mapFrame(sc.compassPins())!;
    expect(f1.pins.some((p) => p.kind === 'site' && Math.abs(p.z - site.z) < 1)).toBe(true);
    sc.players[0].placeAt(roadX(sc.terrain!, 20), 20, 0);
    expect(sc.mapFrame(sc.compassPins())!.pins.some((p) => p.kind === 'site' && Math.abs(p.z - site.z) < 1)).toBe(true);
    sc.dispose();
  }, 60000);

  it('shows the dead only once they are chasing', () => {
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('L2C'));
    run(sc, 0.3);
    const p = sc.players[0];
    const x = p.vehicle?.position.x ?? p.pos.x;
    const z = p.vehicle?.position.z ?? p.pos.z;
    sc.zombies.list.length = 0;
    sc.zombies.spawn('walker', x + 20, z + 20, true);
    sc.zombies.spawn('walker', x - 20, z + 25, false);
    const calm = sc.mapFrame(sc.compassPins())!;
    expect(calm.blips.filter((b) => b.kind === 'foe')).toHaveLength(0);
    const hunter = sc.zombies.list[1];
    hunter.state = 'chase';
    const hot = sc.mapFrame(sc.compassPins())!;
    expect(hot.blips.filter((b) => b.kind === 'foe')).toHaveLength(1);
    sc.dispose();
  }, 60000);

  it('a tap of the map button steps the seat through the views and back to the minimap', () => {
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('L1'));
    run(sc, 0.2);
    const p = sc.players[0];
    expect(p.mapMode).toBe(0);
    const tap = () => {
      h.intents[0].pressed |= 1 << Btn.Map;
      sc.tick(1 / 60);
      h.intents[0].pressed = 0;
      sc.tick(1 / 60);
    };
    tap();
    expect(p.mapMode).toBe(1);
    tap();
    expect(p.mapMode).toBe(2);
    tap();
    expect(p.mapMode).toBe(0);
    // The other seat is not touched.
    expect(sc.players[1].mapMode).toBe(0);
    sc.dispose();
  }, 60000);

  it('a delve uncovers its map as the party walks, and a camp is a radar with no ground', () => {
    const h = fakeServices();
    const parent = new LegScene(h.svc, legById('L1'));
    for (const p of parent.players) p.exitVehicle(false);
    run(parent, 0.3);
    const site: DelveSite = { id: 'T:m', theme: 'bunker', x: 0, z: 0, yaw: 0, seed: 123, name: 'Test Bunker', tier: 2, island: false };
    parent.suspend();
    const d = new DelveScene(h.svc, parent.leg, site, parent.delveRecord(site.id), parent.players.map(carryOf));
    run(d, 1);
    expect(d.mapModes).toBe(2);
    const f = d.mapFrame(d.compassPins())!;
    expect(f.mode).toBe('delve');
    expect(f.title).toBe('Test Bunker');
    expect(f.overview).toBe(false);
    expect(known(f.base!, d.players[0].pos.x, d.players[0].pos.z)).toBe(true);
    // The exit is always on the map; a chest across the cave is not until it has been seen.
    expect(f.pins.some((p) => p.kind === 'exit')).toBe(true);
    d.dispose();
  }, 60000);
});
