import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { GANGS, legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { ChunkSource } from '../src/world/chunkgen';
import { waterAt } from '../src/world/terrain';
import { gangAt, guardCount } from '../src/world/gangCamps';
import { propProto } from '../src/render/props';
import { fakeServices, run } from './helpers/sim';

vi.setConfig({ testTimeout: 120000 });

beforeAll(async () => {
  await initPhysics();
});

const leg = legById('W');

function open(memory = new WorldMemory()) {
  const h = fakeServices();
  const sc = new LegScene(h.svc, leg, { memory });
  return { h, sc, memory };
}

/** Put both convoys `dist` metres south of a point and let the world stream in. */
function approach(sc: LegScene, x: number, z: number, dist: number) {
  const zz = z - dist;
  for (const p of sc.players) p.vehicle!.body.setPose(x + (p.index ? 6 : 0), sc.groundAt(x, zz) + 1.2, zz, 0);
  run(sc, 3);
}

describe('gang camps in the layout', () => {
  const L = new ChunkSource(leg).layout;
  const T = L.terrain;

  it('are scattered over the open world, each held by one gang', () => {
    expect(L.gangCamps.length).toBeGreaterThanOrEqual(4);
    for (const c of L.gangCamps) {
      expect(Object.keys(GANGS)).toContain(c.gang);
      expect(c.gang).toBe(gangAt(leg.seed, c.x, c.z));
      expect(waterAt(T, c.x, c.z)).toBeNull();
    }
    expect(new Set(L.gangCamps.map((c) => c.id)).size).toBe(L.gangCamps.length);
  });

  it('are the same every time the layout is built from the seed', () => {
    const again = new ChunkSource(leg).layout;
    expect(again.gangCamps.map((c) => [c.id, c.x, c.z, c.gang, c.guards.length])).toEqual(L.gangCamps.map((c) => [c.id, c.x, c.z, c.gang, c.guards.length]));
  });

  it('have sentries, a fire, tents, banners and a stash', () => {
    for (const c of L.gangCamps) {
      const n = guardCount(c.tier);
      expect(c.guards.filter((g) => g.kind === 'gunman')).toHaveLength(n.gunmen);
      expect(c.guards.filter((g) => g.kind === 'sniper')).toHaveLength(n.snipers);
      const near = (p: { x: number; z: number }) => Math.hypot(p.x - c.x, p.z - c.z) < c.radius + 4;
      const props = L.props.filter(near);
      expect(props.some((p) => p.kind === 'campfire')).toBe(true);
      expect(props.filter((p) => p.kind === 'tent').length).toBeGreaterThanOrEqual(3);
      expect(props.filter((p) => p.kind === 'banner' && p.tag === GANGS[c.gang].tag).length).toBeGreaterThanOrEqual(3);
      const loot = L.pickups.filter((p) => p.id.includes(':gc') && near(p));
      expect(loot.length).toBeGreaterThanOrEqual(5);
      expect(L.ambushes.some((a) => a.camp === c.id && a.triggerRadius === 0)).toBe(true);
    }
  });
});

describe('gang camp props', () => {
  it('build real meshes, and each gang flies its own banner', () => {
    for (const kind of ['tent', 'campfire'] as const) for (let seed = 0; seed < 4; seed++) expect(propProto(kind, seed, 7).vertexCount).toBeGreaterThan(50);
    for (const g of Object.values(GANGS)) expect(propProto('banner', 1, g.tag).vertexCount).toBeGreaterThan(50);
  });
});

describe('gang camps in play', () => {
  it('put sentries on their posts only once someone is near, and they stand quiet until they notice you', () => {
    const { sc } = open();
    const camp = sc.src.layout.gangCamps[0];
    run(sc, 2);
    expect(sc.raiders.units.filter((u) => u.post?.camp === camp.id)).toHaveLength(0);
    approach(sc, camp.x, camp.z, 150);
    const guards = sc.raiders.units.filter((u) => u.post?.camp === camp.id);
    expect(guards.length).toBeGreaterThanOrEqual(3);
    run(sc, 4);
    expect(guards.every((u) => !u.alerted && !u.dead)).toBe(true);
    // They stay within their patrol.
    for (const u of guards) expect(Math.hypot(u.x - u.post!.x, u.z - u.post!.z)).toBeLessThan(u.post!.patrol + 2);
  });

  it('raise the alarm together when one is hit, and send the camp buggies out', () => {
    const { sc } = open();
    const camp = sc.src.layout.gangCamps[0];
    approach(sc, camp.x, camp.z, 150);
    const guards = sc.raiders.units.filter((u) => u.post?.camp === camp.id);
    sc.raiders.damageInfantry(guards[0], 1, 0);
    expect(guards.every((u) => u.alerted)).toBe(true);
    const a = sc.ambushes.find((q) => q.spec.camp === camp.id)!;
    expect(a.state).not.toBe('idle');
    run(sc, 6);
    expect(sc.vehicles.some((v) => v.faction === 'raider')).toBe(true);
  });

  it('go back to their posts and stand down once nobody is about', () => {
    const { sc } = open();
    const camp = sc.src.layout.gangCamps[0];
    approach(sc, camp.x, camp.z, 150);
    const guards = sc.raiders.units.filter((u) => u.post?.camp === camp.id);
    sc.raiders.alertCamp(camp.id);
    // Everyone drives off; the sentries lose them.
    for (const p of sc.players) p.vehicle!.body.setPose(camp.x, sc.groundAt(camp.x, camp.z - 700) + 1.2, camp.z - 700, 0);
    run(sc, 20);
    expect(guards.every((u) => !u.alerted)).toBe(true);
  });

  it('are broken for good once the last sentry falls, and stay dead the next morning', () => {
    const first = open();
    const { sc, memory } = first;
    const camp = sc.src.layout.gangCamps[0];
    approach(sc, camp.x, camp.z, 150);
    const guards = sc.raiders.units.filter((u) => u.post?.camp === camp.id);
    const radio: string[] = [];
    first.h.svc.onRadio = (t: string) => void radio.push(t);
    for (const u of guards) sc.raiders.damageInfantry(u, 9999, 0);
    run(sc, 2);
    expect(sc.gangCamps.isCleared(camp.id)).toBe(true);
    expect(sc.gangCamps.pins().some((p) => p.x === camp.x)).toBe(false);
    sc.capture(memory);
    expect(memory.gangKilled.size).toBe(guards.length);
    // Survives a save and reload.
    const restored = WorldMemory.restore(JSON.parse(JSON.stringify(memory.serialize())));
    expect(restored.gangKilled.size).toBe(guards.length);
    sc.dispose();

    const second = open(restored);
    const camp2 = second.sc.src.layout.gangCamps.find((c) => c.id === camp.id)!;
    expect(second.sc.gangCamps.isCleared(camp2.id)).toBe(true);
    approach(second.sc, camp2.x, camp2.z, 150);
    expect(second.sc.raiders.units.filter((u) => u.post?.camp === camp2.id)).toHaveLength(0);
  });

  it('show on the map and compass once seen, not before', () => {
    const { sc } = open();
    const camp = sc.src.layout.gangCamps[0];
    run(sc, 2);
    expect(sc.compassPins().some((p) => p.kind === 'threat' && p.x === camp.x)).toBe(false);
    approach(sc, camp.x, camp.z, 300);
    expect(sc.compassPins().some((p) => p.kind === 'threat' && p.x === camp.x)).toBe(true);
  });
});
