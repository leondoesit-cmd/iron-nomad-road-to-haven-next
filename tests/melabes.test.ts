import { beforeAll, describe, expect, it } from 'vitest';
import { legById } from '../src/data';
import { initPhysics } from '../src/physics/physics';
import { ChunkSource } from '../src/world/chunkgen';
import { MELABES, melabesFrame, melabesPose } from '../src/world/melabes';
import { MelabesWorker } from '../src/render/shopWorker';
import { LegScene } from '../src/game/legScene';
import { Campaign } from '../src/game/campaign';
import { DrugState, DRUG_IDS } from '../src/sim/drugs';
import { Btn } from '../src/input/intents';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => { await initPhysics(); });
const leg = legById('L3P');

describe('Melabes interior and service', () => {
  it('leaves a deep ground-floor opening in render and obstacle data with solid equipment', () => {
    const src = new ChunkSource(leg);
    const shop = src.cityBuildings().find((b) => b.shop === 'malabes')!;
    const frame = melabesFrame(shop.aabb);
    const chunk = src.get(0, Math.floor(frame.z / 128));
    const inside = frame.point(1.8, -4.1);
    expect(src.layout.blockedAt(inside.x, inside.z, 0.25)).toBe(false);
    const boxes = src.allAabbs();
    const hits = (p: { x: number; z: number }, y: number) => boxes.filter((a) => p.x > a.minX && p.x < a.maxX && p.z > a.minZ && p.z < a.maxZ && y > a.y0 && y < a.y1);
    expect(hits(inside, 1)).toHaveLength(0);
    expect(hits(inside, 3.1).length).toBeGreaterThan(0);
    expect(hits(frame.point(1.8, -5.2), 1).length).toBeGreaterThan(0);
    for (const x of MELABES.spits) expect(hits(frame.point(x, MELABES.spitZ), 1.5).length).toBeGreaterThan(0);
    expect(chunk.aabbs).not.toContain(shop.aabb);
    expect(shop.colliders).toHaveLength(4);
  });

  it('walks around both stacks without intersecting them, carves each, and offers the portions', () => {
    const worker = new MelabesWorker();
    let rear = false;
    for (let time = 0; time < MELABES.cycle; time += 0.05) {
      const pose = melabesPose(time);
      rear ||= pose.z < MELABES.spitZ - 1;
      expect(pose.x).toBeGreaterThan(-MELABES.halfWidth + 0.25);
      expect(pose.z).toBeGreaterThan(-MELABES.depth + 0.25);
      for (const x of MELABES.spits) expect(Math.hypot(pose.x - x, pose.z - MELABES.spitZ)).toBeGreaterThan(0.67);
      worker.update(time);
      worker.root.updateMatrixWorld(true);
      worker.root.traverse((part) => {
        expect(part.matrixWorld.elements.every(Number.isFinite)).toBe(true);
        if (part.name === 'worker-upper-arm' || part.name === 'worker-forearm') expect(part.scale.y).toBeCloseTo(0.32, 6);
      });
    }
    expect(rear).toBe(true);
    expect(melabesPose(4).carving).toBe(true);
    expect(melabesPose(12).carving).toBe(true);
    expect(melabesPose(19).serving).toBe(true);
    worker.update(19, 0);
    worker.dispose();
  });

  it('lets both players collect by holding interact and triggers each dose 30 seconds after their own meal', () => {
    const h = fakeServices();
    const sc = new LegScene(h.svc, leg, { training: true });
    for (const p of sc.players) {
      p.exitVehicle(false);
      p.drugs.rest();
    }
    sc.time = 18.2;
    const serving = sc.interact.list.find((i) => i.id === 'melabes:serving')!;
    expect(serving).toBeDefined();
    const collect = (index: 0 | 1) => {
      const p = sc.players[index];
      p.placeAt(serving.x, serving.z + index * 0.6, 0);
      run(sc, 0.15);
      const input = h.intents[index];
      input.held = input.pressed = 1 << Btn.A;
      sc.tick(1 / 60);
      input.pressed = 0;
      expect(p.prompt?.text).toBe(serving.prompt);
      run(sc, 0.65);
      input.held = 0;
      sc.tick(1 / 60);
      expect(p.drugs.delayed).toHaveLength(1);
      expect(DRUG_IDS).toContain(p.drugs.delayed[0].id);
      expect(serving.enabled(p)).toBe(false);
    };
    collect(0);
    const leftAtSecond = sc.players[0].drugs.delayed[0].left;
    collect(1);
    expect(sc.players[0].drugs.delayed[0].left).toBeLessThan(leftAtSecond);
    expect(sc.players[1].drugs.delayed[0].left).toBeGreaterThan(sc.players[0].drugs.delayed[0].left);
    expect(sc.players.map((p) => p.drugs.active.length)).toEqual([0, 0]);
    const firstLeft = sc.players[0].drugs.delayed[0].left;
    for (const p of sc.players) p.drugs.update(firstLeft - 0.01);
    expect(sc.players.map((p) => p.drugs.active.length)).toEqual([0, 0]);
    for (const p of sc.players) p.drugs.update(0.02);
    expect(sc.players.map((p) => p.drugs.active.length)).toEqual([1, 0]);
    sc.players[1].drugs.update(1);
    expect(sc.players[1].drugs.active).toHaveLength(1);
    expect(sc.players[0].drugs.active[0].age).toBe(0);
    sc.time = 40.5;
    expect(serving.enabled(sc.players[0])).toBe(true);
    expect(serving.enabled(sc.players[1])).toBe(true);
    sc.dispose();
  }, 60000);

  it('preserves a pending meal through campaign saves without touching the other player or inventory', () => {
    const campaign = new Campaign(undefined, true);
    const stocks = { ...campaign.items };
    campaign.drugs[0].scheduleDose('weed', 30, 'Melabes shawarma');
    campaign.drugs[0].update(12);
    const restored = Campaign.deserialize(campaign.serialize());
    restored.drugs[0].update(17.99);
    expect(restored.drugs[0].active).toHaveLength(0);
    restored.drugs[0].update(0.01);
    expect(restored.drugs[0].active[0].id).toBe('weed');
    expect(restored.drugs[1].active).toHaveLength(0);
    expect(restored.items).toEqual(stocks);
    expect(DrugState.restore(undefined).delayed).toEqual([]);
  });
});
