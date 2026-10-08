import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { vegetationKey } from '../src/sim/vegetation';
import { TREE_SPECIES, type TreeSpot } from '../src/world/flora';
import type { ChunkView } from '../src/render/chunkview';
import { fakeServices, run } from './helpers/sim';

// Gunfire into a real wood on the open-world leg, headless: the rounds go through combat, the wood chips, the tree snaps,
// its stump stays in the way at its new height and the top comes down. And the world remembers it after the night.

vi.setConfig({ testTimeout: 240000 });

beforeAll(async () => {
  await initPhysics();
});

const leg = legById('W');

function chunks(sc: LegScene): Map<number, ChunkView> {
  return (sc as unknown as { chunks: Map<number, ChunkView> }).chunks;
}

/** The nearest standing tree of a species to a point, in the loaded chunks, with no other within `room` m. */
function nearest(sc: LegScene, x: number, z: number, sp: string, room = 0) {
  const all: TreeSpot[] = [];
  for (const view of chunks(sc).values()) all.push(...view.data.trees);
  let best: { view: ChunkView; i: number; t: TreeSpot; d: number } | null = null;
  for (const view of chunks(sc).values()) {
    view.data.trees.forEach((t, i) => {
      if (TREE_SPECIES[t.sp] !== sp || view.vegetation.treeBroken(i)) return;
      if (room && all.some((o) => o !== t && Math.hypot(o.x - t.x, o.z - t.z) < room)) return;
      const d = Math.hypot(t.x - x, t.z - z);
      if (!best || d < best.d) best = { view, i, t, d };
    });
  }
  return best!;
}

describe('shooting a tree down in a wood', () => {
  it('chips it, snaps it with an assault rifle, keeps its stump in the way and brings its top down', () => {
    const h = fakeServices({ solo: true });
    const memory = new WorldMemory();
    const sc = new LegScene(h.svc, leg, { memory, start: { x: -1700, z: 1300, yaw: 0 } });
    run(sc, 2);
    const p = sc.players[0];
    if (p.vehicle) p.exitVehicle(false);
    run(sc, 0.5);
    // A pine standing on its own at the edge of the wood, so its top comes down clear of its neighbours.
    const { view, i, t } = nearest(sc, -1700, 1300, 'pine', 10);
    const plant = view.vegetation.plants.find((q) => q.treeIndex === i)!;
    const ty = sc.groundAt(t.x, t.z);
    // From a few metres off, square on to the trunk at chest height.
    const ox = t.x - 6, oz = t.z;
    const oy = sc.groundAt(ox, oz) + 1.5;
    const fire = () => {
      const dx = t.x - ox, dy = ty + 1.3 - oy, dz = t.z - oz, l = Math.hypot(dx, dy, dz);
      sc.combat.shoot(ox, oy, oz, dx / l, dy / l, dz / l, { side: 'convoy', owner: p, damage: 30, ammo: 'carbine', range: 40 });
      run(sc, 0.1);
    };
    const marks0 = sc.gore.placed;
    fire();
    const chips = sc.gore.timber.chips;
    expect(chips.count('chip')).toBeGreaterThan(2);
    expect(chips.count('bark')).toBeGreaterThan(0);
    expect(sc.gore.placed).toBeGreaterThan(marks0);
    expect(Math.max(...plant.record.notch!)).toBeGreaterThan(0);
    let n = 1;
    while (!plant.record.broken && n < 120) {
      fire();
      n++;
    }
    expect(plant.record.broken).toBe(true);
    expect(plant.record.cut).toBeDefined();
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(70);
    expect(sc.gore.timber.snaps).toBe(1);
    // The stump still stands in the way, lower; birds and fires no longer count it as a tree.
    const box = view.data.aabbs.find((a) => a.kind === 'tree' && Math.abs((a.minX + a.maxX) / 2 - t.x) < 0.01 && Math.abs((a.minZ + a.maxZ) / 2 - t.z) < 0.01)!;
    expect(box.physOnly).toBeFalsy();
    expect(sc.obs.byId(box.id)).toBeTruthy();
    expect(box.y1).toBeLessThan(ty + 2.6);
    expect(box.y1).toBeGreaterThan(ty + 0.8);
    expect(sc.treesNear(t.x, t.z, 1).includes(t)).toBe(false);
    // A walker standing where it comes down is crushed under it.
    const d = plant.record.direction!;
    sc.zombies.spawn('walker', t.x + d[0] * 7, t.z + d[1] * 7, true);
    const walker = sc.zombies.list[sc.zombies.list.length - 1];
    const hp = walker.hp;
    run(sc, 6);
    expect(walker.dead || walker.hp < hp).toBe(true);
    // Down on the ground, not hung up.
    const r = plant.body!.rotation();
    expect(1 - 2 * (r.x * r.x + r.z * r.z)).toBeLessThan(0.5);
    expect(sc.gore.timber.landings).toBe(1);
    // The world remembers the stump and where the top lies, for the next time this chunk is drawn.
    sc.capture(memory);
    const rec = memory.vegetation.get(vegetationKey('tree', plant.position.x, plant.position.z))!;
    expect(rec.cut).toBeCloseTo(plant.record.cut!, 6);
    expect(rec.pose).toHaveLength(7);
    const saved = JSON.parse(JSON.stringify(memory.serialize()));
    sc.dispose();
    const again = new LegScene(h.svc, leg, { memory: WorldMemory.restore(saved), start: { x: -1700, z: 1300, yaw: 0 } });
    run(again, 1);
    const view2 = [...chunks(again).values()].find((v) => v.data.trees.some((q) => q.x === t.x && q.z === t.z))!;
    const i2 = view2.data.trees.findIndex((q) => q.x === t.x && q.z === t.z);
    expect(view2.vegetation.treeBroken(i2)).toBe(true);
    const p2 = view2.vegetation.plants.find((q) => q.treeIndex === i2)!;
    expect(p2.stump).toBeDefined();
    // Put back where it lay (it may settle a hand's breadth against its stump and the ground as they come back).
    const b2 = p2.body!.translation();
    expect(Math.hypot(b2.x - rec.pose![0], b2.z - rec.pose![2])).toBeLessThan(0.5);
    expect(b2.y).toBeGreaterThan(rec.pose![1] - 0.5);
    again.dispose();
  });
});
