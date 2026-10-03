import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { Campaign } from '../src/game/campaign';
import { fakeServices, run } from './helpers/sim';

// Real open-world scenes in Node.
vi.setConfig({ testTimeout: 120000 });

beforeAll(async () => {
  await initPhysics();
});

const leg = legById('W');

function open(memory = new WorldMemory(), start?: { x: number; z: number; yaw: number }) {
  const h = fakeServices();
  const results: { type: string }[] = [];
  const sc = new LegScene(h.svc, leg, { memory, start });
  sc.onResult = (r) => results.push(r);
  return { h, sc, memory, results, c: h.campaign };
}

describe('the open world in play', () => {
  it('starts on the highway with the world streaming around the convoy', () => {
    const { sc } = open();
    run(sc, 3);
    expect(sc.chunks.size).toBeGreaterThan(9);
    expect(sc.biome).toBe('wasteland');
    expect(sc.players[0].vehicle).toBeTruthy();
    expect(sc.cityMix).toBe(0);
  });

  it('is city once you are driving through Petah Tikva, and wasteland again beyond it', () => {
    const { sc } = open();
    const T = sc.terrain!;
    const d = T.open!.districts[0];
    const put = (z: number) => {
      for (const p of sc.players) {
        const v = p.vehicle!;
        v.body.setPose(0, sc.groundAt(0, z) + 1.2, z, 0);
      }
    };
    put(d.z0 + 300);
    run(sc, 4);
    expect(sc.biome).toBe('city');
    expect(sc.lightCity).toBeGreaterThan(0.9);
    put(d.z1 + 400);
    run(sc, 6);
    expect(sc.biome).toBe('wasteland');
    expect(sc.lightCity).toBeLessThan(0.1);
  });

  it('calls the camp after the Dusk Bell, remembers the day, and rolls out again from the same place', () => {
    const first = open();
    const { sc, memory, results } = first;
    // Loot something, then let dusk fall.
    const zone = sc.src.layout.zones.find((z) => z.containers.length)!;
    zone.containers[0].taken = true;
    sc.takenPickups.add('W:test-pickup');
    sc.clock.elapsed = 0.73 * sc.clock.dayLength;
    run(sc, 1);
    expect(sc.clock.bellRung).toBe(true);
    // Step out on foot and hold the camp prompt.
    const p = sc.players[0];
    p.vehicle!.driver = null;
    p.vehicle = null;
    p.state = 'foot';
    const camp = sc.interact.list.find((i) => i.id === 'camp:0')!;
    expect(camp.enabled(p)).toBe(true);
    camp.run(p);
    expect(results.map((r) => r.type)).toEqual(['dusk']);
    expect(sc.campPose).not.toBeNull();
    const pose = sc.campPose!;
    sc.capture(memory);
    expect(memory.camp).toEqual(pose);
    expect(memory.searched.has(zone.containers[0].id)).toBe(true);
    sc.dispose();

    // A new scene, a morning later: same layout object, same loot taken, convoy at the camp.
    const second = open(memory, pose);
    expect(second.sc.src).toBe(first.sc.src);
    expect(second.sc.takenPickups.has('W:test-pickup')).toBe(true);
    expect(zone.containers[0].taken).toBe(true);
    run(second.sc, 2);
    const v = second.sc.players[0].vehicle!;
    expect(Math.hypot(v.position.x - pose.x, v.position.z - pose.z)).toBeLessThan(100);
    expect(second.sc.clock.t).toBeLessThan(0.2);
  });

  it('streams ground far from the highway and the convoy can drive across it', () => {
    const { sc, h } = open();
    const [x, z] = [1500, 1200];
    for (const p of sc.players) p.vehicle!.body.setPose(x + (p.index ? 6 : 0), sc.groundAt(x, z) + 1.2, z, 0);
    run(sc, 3);
    expect(sc.chunks.has(Math.floor(x / 128) * 4096 + Math.floor(z / 128))).toBe(true);
    const it = h.intents[0];
    it.device = 'keyboard';
    it.move = [0, 1];
    const v = sc.players[0].vehicle!;
    const z0 = v.position.z;
    run(sc, 8);
    expect(Number.isFinite(v.position.x) && Number.isFinite(v.position.y)).toBe(true);
    expect(Math.abs(v.position.z - z0) + Math.abs(v.position.x - x)).toBeGreaterThan(10);
    expect(v.position.y).toBeGreaterThan(sc.groundAt(v.position.x, v.position.z) - 1);
  });

  it('reaches Haven at the north end of the highway', () => {
    const { sc, results } = open();
    const end = sc.src.layout.end;
    for (const p of sc.players) p.vehicle!.body.setPose(end.x, sc.groundAt(end.x, end.z) + 1.2, end.z, 0);
    run(sc, 3);
    expect(results.some((r) => r.type === 'haven')).toBe(true);
    expect(sc.campaign.flags.haven).toBe(true);
  });

  it('saves and restores what the world remembers', () => {
    const { sc, memory } = open();
    sc.takenPickups.add('W:a');
    sc.doneEncounters.add('W:e1');
    sc.campPose = { x: 5, z: 1200, yaw: 1 };
    sc.capture(memory);
    const back = WorldMemory.restore(JSON.parse(JSON.stringify(memory.serialize())));
    expect(back.takenPickups.has('W:a')).toBe(true);
    expect(back.doneEncounters.has('W:e1')).toBe(true);
    expect(back.camp).toEqual({ x: 5, z: 1200, yaw: 1 });
  });

  it('puts the world in the save file, so Continue rolls out where the convoy slept', () => {
    const { sc, memory, c } = open();
    sc.takenPickups.add('W:b');
    sc.campPose = { x: 3, z: 700, yaw: 0.5 };
    sc.capture(memory);
    c.worldSave = memory.serialize();
    c.legId = 'W';
    const back = Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize())));
    const world = WorldMemory.restore(back.worldSave);
    expect(world.camp).toEqual({ x: 3, z: 700, yaw: 0.5 });
    expect(world.takenPickups.has('W:b')).toBe(true);
    // And an old save, from before the open world, has none.
    const old = c.serialize() as Record<string, unknown>;
    delete old.world;
    expect(Campaign.deserialize(old as ReturnType<Campaign['serialize']>).worldSave).toBeUndefined();
  });
});
